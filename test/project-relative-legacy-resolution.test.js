import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { importLegacyPlugin, initializeLegacyPlugin, loadLegacyPlugins, resolveLegacyTarget } from '../src/legacy-loader.js'

const legacy = label => `export default async()=>({tool:{sample:{execute:async()=>${JSON.stringify(label)}}}})`
const url = async file => pathToFileURL(await realpath(file)).href

async function fixture(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'v1 esm '))
  const worktree = path.join(home, 'project')
  const base = path.join(worktree, 'nested # dir')
  await mkdir(base, { recursive: true })
  const options = {baseDirectory: base, projectDirectory: worktree}
  const resolve = (target, overrides) => resolveLegacyTarget(target, {...options,...overrides})
  async function put(file, contents) {
    await mkdir(path.dirname(file), {recursive:true})
    await writeFile(file, contents, {flag:'wx'})
    return file
  }
  async function pkg(at, name, manifest, files={}) {
    const dir = path.join(at,'node_modules',name)
    await put(path.join(dir,'package.json'), JSON.stringify({name,type:'module',...manifest}))
    for (const [file,value] of Object.entries(files)) await put(path.join(dir,file),value)
    return dir
  }
  try { await run({home,worktree,base,options,resolve,put,pkg}) }
  finally { await rm(home,{recursive:true,force:true}) }
}

test('nearest installed package uses its import export even when require is listed first', () => fixture(async ({base,worktree,options,resolve,pkg}) => {
  await pkg(worktree,'v1-dual',{exports:'./unselected.mjs'},{'unselected.mjs':'throw Error("outer package evaluated")'})
  const dir = await pkg(base,'v1-dual',{exports:{'.':{require:'./require.cjs',import:'./import.mjs'}}},{
    'import.mjs':legacy('import'), 'require.cjs':'throw Error("require branch evaluated")',
  })
  assert.equal(await resolve('v1-dual'),await url(path.join(dir,'import.mjs')))
  const loaded = await initializeLegacyPlugin(await importLegacyPlugin('v1-dual',options),{})
  assert.equal(await loaded.hooks.tool.sample.execute(),'import')
  await loaded.dispose()
}))

test('scoped package roots, exact subpaths, patterns and nested worktree installs use native resolution', () => fixture(async ({worktree,resolve,pkg}) => {
  const dir = await pkg(worktree,'@legacy/v1-package',{exports:{'.':'./entry.mjs','./part':'./modules/part.mjs','./features/*':'./modules/*.mjs'}},{
    'entry.mjs':legacy('root'), 'modules/part.mjs':legacy('part'), 'unexported.mjs':legacy('private'),
  })
  assert.equal(await resolve('@legacy/v1-package'),await url(path.join(dir,'entry.mjs')))
  assert.equal(await resolve('@legacy/v1-package/part'),await url(path.join(dir,'modules/part.mjs')))
  assert.equal(await resolve('@legacy/v1-package/features/part'),await url(path.join(dir,'modules/part.mjs')))
  await assert.rejects(resolve('@legacy/v1-package/unexported.mjs'))
}))

test('ordinary CommonJS main loads through import; a require-only export fails explicitly', () => fixture(async ({base,options,pkg}) => {
  const files = {'entry.cjs':'module.exports=async()=>({event(){}})'}
  await pkg(base,'v1-cjs',{type:'commonjs',main:'./entry.cjs'},files)
  await pkg(base,'v1-require-only',{type:'commonjs',main:'./entry.cjs',exports:{require:'./entry.cjs'}},files)
  const loaded = await initializeLegacyPlugin(await importLegacyPlugin('v1-cjs',options),{})
  assert.equal(typeof loaded.hooks.event,'function')
  await loaded.dispose()
  await assert.rejects(importLegacyPlugin('v1-require-only',options),error=>error.stage==='resolution')
}))

test('invalid, blocked and missing exports fail during resolution without substituting an outer package', () => fixture(async ({base,worktree,options,pkg}) => {
  const data = {
    'v1-bad-target':'../neighbor.mjs',
    'v1-bad-map':{'.':'./entry.mjs',default:'./entry.mjs'},
    'v1-numeric':{'.':{1:'./entry.mjs',default:'./entry.mjs'}},
    'v1-inactive':{arbitrary:'./entry.mjs'},
    'v1-null':{'.':null},
    'v1-gone':'./gone.mjs',
    'v1-no-extension':'./entry',
    'v1-directory':'./nested',
  }
  for (const [name,exports] of Object.entries(data)) {
    await pkg(worktree,name,{exports:'./outer.mjs'},{'outer.mjs':legacy('outer')})
    await pkg(base,name,{main:'./entry.mjs',exports},{
      'entry.mjs':'throw Error("main evaluated")','nested/index.js':legacy('directory'),
    })
    await assert.rejects(importLegacyPlugin(name,options),error=>error.stage==='resolution',name)
  }
  await assert.rejects(importLegacyPlugin('v1-no-package',options),error=>
    error.stage==='resolution'&&error.cause.code==='ERR_MODULE_NOT_FOUND')
}))

test('dependency and module-evaluation failures occur in import; factory failures occur in initialization', () => fixture(async ({base,options,pkg}) => {
  for (const [name,source] of Object.entries({
    'v1-missing-dependency':'import "v1-definitely-missing-dep";export default async()=>({})',
    'v1-wrong-format':'module.exports=async()=>({})',
    'v1-bad-module':'export default async (',
    'v1-factory-error':'export default async()=>{throw Error("factory rejected")}',
  })) await pkg(base,name,{exports:'./index.js'},{'index.js':source})
  await assert.rejects(importLegacyPlugin('v1-missing-dependency',options),error=>
    error.stage==='import'&&/v1-definitely-missing-dep/.test(error.cause.message))
  // Bun accepts a CommonJS-style source file that Node rejects in this ESM package.
  if (process.versions.bun) {
    assert.equal((await importLegacyPlugin('v1-wrong-format',options)).kind,'legacy-function')
  } else {
    await assert.rejects(importLegacyPlugin('v1-wrong-format',options),error=>
      error.stage==='import'&&/module|exports/.test(error.cause.message))
  }
  await assert.rejects(importLegacyPlugin('v1-bad-module',options),error=>
    error.stage==='import'&&/Unexpected end of (input|file)/.test(error.cause.message))
  const imported = await importLegacyPlugin('v1-factory-error',options)
  await assert.rejects(initializeLegacyPlugin(imported,{}),error=>
    error.stage==='initialization'&&error.cause.message==='factory rejected')
}))

test('relative, absolute and file URL references agree on the canonical file with Windows spelling aliases', () => fixture(async ({base,worktree,resolve,put}) => {
  const file = await put(path.join(worktree,'long # name.mjs'),legacy('entry'))
  const expected = await url(file)
  assert.equal(await resolve('../long # name.mjs'),expected)
  assert.equal(await resolve(file),expected)
  assert.equal(await resolve(expected),expected)
  if (process.platform==='win32') {
    assert.equal(await resolve(file.toLowerCase().replaceAll('\\','/'),{baseDirectory:base.toLowerCase()}),expected)
  }
}))

test('bare packages cannot come from an unrelated ancestor or a different activation project', () => fixture(async ({home,base,worktree,resolve,options,pkg}) => {
  const other = path.join(home,'project-other')
  await pkg(home,'v1-ancestor',{exports:'./index.mjs'},{'index.mjs':'throw Error("ancestor evaluated")'})
  await pkg(other,'v1-isolated',{exports:'./index.mjs'},{'index.mjs':legacy('other')})
  await pkg(worktree,'v1-isolated',{exports:'./index.mjs'},{'index.mjs':legacy('first')})
  await assert.rejects(resolve('v1-ancestor'),/in the activation project/)
  await assert.rejects(resolve('v1-isolated',{baseDirectory:other,projectDirectory:worktree}),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  const [a,b] = await Promise.all([
    importLegacyPlugin('v1-isolated',{...options,baseDirectory:base}),
    importLegacyPlugin('v1-isolated',{baseDirectory:other}),
  ])
  assert.notEqual(a.url,b.url)
  assert.notEqual(a.factory,b.factory)
  assert.equal(await (await a.factory()).tool.sample.execute(),'first')
  assert.equal(await (await b.factory()).tool.sample.execute(),'other')
}))

test('rejects traversal and remote, builtin, drive-relative and device specifiers', () => fixture(async ({home,resolve,put}) => {
  const outside = await put(path.join(home,'elsewhere.mjs'),legacy('explicit selection'))
  await assert.rejects(resolve('../../elsewhere.mjs'),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  assert.equal(await resolve(outside),await url(outside))
  for (const target of ['v1/../elsewhere','@scope/../elsewhere','v1/%2e%2e/elsewhere','v1@1.0.0',
    'fs','node:fs','https://invalid.example/a.mjs','data:text/javascript,export default 1','file://server/share/file.mjs',
    'C:relative.mjs','file:///C:/a.mjs#extra','file:///C:/a.mjs?extra']) {
    await assert.rejects(resolve(target),TypeError,target)
  }
  if (process.platform==='win32') for (const target of ['\\\\server\\share\\x.mjs','\\\\?\\C:\\x.mjs','C:\\x.mjs:other','\\x.mjs','C:\\NUL.mjs']) {
    await assert.rejects(resolve(target),TypeError,target)
  }
}))

test('canonical aliases collapse and junctions outside the worktree or selected package are refused', () => fixture(async ({home,base,worktree,resolve,put,pkg,options}) => {
  const linkType = process.platform==='win32'?'junction':'dir'
  const dir = await pkg(worktree,'v1-real',{exports:'./entry.mjs'},{'entry.mjs':legacy('ok')})
  const foreign = await pkg(home,'v1-foreign',{exports:'./entry.mjs'},{'entry.mjs':'throw Error("unowned module evaluated")'})
  const redirect = await pkg(base,'v1-redirect',{exports:'./redirect/entry.mjs'})
  const local = await pkg(base,'v1-local',{exports:'./entry.mjs'},{'entry.mjs':legacy('local')})
  const linkedManifest = path.join(base,'node_modules','v1-linked-manifest')
  await mkdir(linkedManifest)
  await put(path.join(foreign,'hidden.mjs'),legacy('hidden'))
  await symlink(dir,path.join(base,'node_modules','v1-linked'),linkType)
  await symlink(foreign,path.join(base,'node_modules','v1-unowned'),linkType)
  await symlink(local,path.join(redirect,'redirect'),linkType)
  await symlink(foreign,path.join(base,'foreign'),linkType)
  await symlink(foreign,path.join(linkedManifest,'package.json'),linkType)
  assert.equal(await resolve('v1-linked'),await resolve('v1-real'))
  await assert.rejects(resolve('v1-unowned'),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  await assert.rejects(resolve('v1-redirect'),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  await assert.rejects(resolve('v1-linked-manifest'),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  await assert.rejects(resolve('./foreign/hidden.mjs'),{code:'ERR_LEGACY_TARGET_OUTSIDE_PROJECT'})
  const result = await loadLegacyPlugins(['v1-linked','v1-real'],()=>({}),options)
  assert.equal(result.loaded.length,1)
  assert.equal(result.failures.length,1)
  assert.equal(result.failures[0].error.stage,'deduplication')
  await result.dispose()
}))
