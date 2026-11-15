import module from 'node:module'
import path from 'node:path'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const windows = process.platform === 'win32'
const bareSpecifier = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/

function resolutionError(code, message) {
  return Object.assign(new Error(message), { code })
}

function localPath(value) {
  if (!path.isAbsolute(value) || value.includes('\0') || value.startsWith('//') ||
      windows && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':') ||
        value.split(/[\\/]/).slice(1).some(part =>
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(part) ||
          (part !== '.' && part !== '..' && /[ .]$/.test(part))))) {
    throw new TypeError('Expected an absolute local path; network and device paths are unsupported')
  }
  return value
}

// Check canonical paths with their filesystem spelling, even on Windows.
// path.relative alone is case-insensitive there, including in case-sensitive directories.
function inside(root, candidate) {
  return root === candidate || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function assertInside(root, candidate) {
  if (!inside(root, candidate)) {
    throw resolutionError('ERR_LEGACY_TARGET_OUTSIDE_PROJECT', 'Legacy target leaves its project or installed package: ' + candidate)
  }
}

async function canonicalFile(file, root) {
  const canonical = localPath(await realpath(localPath(file)))
  if (root) assertInside(root, canonical)
  if (!(await stat(canonical)).isFile()) throw new TypeError('Legacy target must be a file; directory entrypoints require explicit files')
  return pathToFileURL(canonical).href
}

async function installedDirectory(parent, name, root) {
  const slot = path.join(parent, name)
  try { await lstat(slot) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  const canonical = localPath(await realpath(slot))
  assertInside(root, canonical)
  if (!(await stat(canonical)).isDirectory()) throw new TypeError('Expected a local package directory: ' + slot)
  return canonical
}

async function findPackage(base, root, name) {
  for (let directory = base; ; directory = path.dirname(directory)) {
    // Authorize the first local install slot before asking the runtime to resolve
    // exports. An ancestor, global location or alternate package cannot replace it.
    let selected = directory
    for (const segment of ['node_modules', ...name.split('/')]) {
      selected = await installedDirectory(selected, segment, root)
      if (selected === undefined) break
    }
    if (selected !== undefined) return selected
    if (directory === root) break
  }
  throw resolutionError('ERR_MODULE_NOT_FOUND', 'Cannot find module ' + JSON.stringify(name) + ' in the activation project')
}

async function checkManifest(directory) {
  const file = path.join(directory, 'package.json')
  try { await lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  const canonical = localPath(await realpath(file))
  assertInside(directory, canonical)
  if (!(await stat(canonical)).isFile()) {
    throw resolutionError('ERR_INVALID_PACKAGE_CONFIG', 'Expected a package manifest file: ' + file)
  }
  if (!process.versions.bun) return
  // Bun 1.4.2 accepts integer condition keys that Node rejects. Validate this
  // divergence without interpreting export targets or choosing conditions.
  const source = await readFile(canonical, 'utf8')
  const pending = [JSON.parse(source.replace(/^\uFEFF/, ''))?.exports]
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if (!Array.isArray(value) && Object.keys(value).some(key => String(key >>> 0) === key && key !== '4294967295')) {
      throw resolutionError('ERR_INVALID_PACKAGE_CONFIG', 'Numeric package export conditions are unsupported: ' + file)
    }
    for (const child of Object.values(value)) pending.push(child)
  }
}

function resolveImport(specifier, directory) {
  if (process.versions.bun) {
    return Bun.resolveSync(specifier, directory)
  }
  if (typeof module.registerHooks !== 'function') {
    throw resolutionError('ERR_LEGACY_ESM_RESOLVER_UNAVAILABLE',
      'Project-relative package imports require Node module.registerHooks or Bun; use an explicit local entry file on this runtime')
  }
  const parentURL = pathToFileURL(path.join(directory, 'package.json')).href
  // Same synchronous Node API used by OpenCode's Node loader. Only rebase this
  // resolution; the hook is gone before any asynchronous work or module import.
  const hook = module.registerHooks({
    resolve(request, context, nextResolve) {
      return nextResolve(request, request === specifier && context.parentURL === import.meta.url
        ? { ...context, parentURL } : context)
    },
  })
  try { return import.meta.resolve(specifier) }
  finally { hook.deregister() }
}

/**
 * Installed packages and relative files are scoped to the activation worktree
 * (or just the supplied base directory when no worktree is available).
 * An absolute file/file URL explicitly selects a local file, including an
 * external artifact. This is entrypoint admission, not a dependency sandbox.
 */
export async function resolveLegacyTarget(target, { baseDirectory = process.cwd(), projectDirectory = baseDirectory } = {}) {
  if (typeof target !== 'string' || !target || target !== target.trim() || target.includes('\0')) {
    throw new TypeError('Legacy plugin target must be a nonempty unpadded string')
  }
  localPath(baseDirectory)
  if (target.startsWith('file:')) {
    const url = new URL(target)
    if (url.hostname || url.search || url.hash) throw new TypeError('Expected an unqualified local file URL')
    return canonicalFile(fileURLToPath(url))
  }
  if (path.isAbsolute(target)) return canonicalFile(target)

  const relative = target.startsWith('./') || target.startsWith('../')
  const parts = target.split('/')
  if (!relative && (!bareSpecifier.test(target) || parts.some(part => part === '.' || part === '..') || module.isBuiltin(target))) {
    throw new TypeError('Ambiguous target; use an explicit relative or absolute local file path or an installed package')
  }
  const root = localPath(await realpath(localPath(projectDirectory)))
  const base = localPath(await realpath(baseDirectory))
  assertInside(root, base)
  if (relative) {
    const file = path.resolve(base, target)
    assertInside(root, file)
    return canonicalFile(file, root)
  }
  const packageName = parts.slice(0, target.startsWith('@') ? 2 : 1).join('/')
  const selected = await findPackage(base, root, packageName)
  await checkManifest(selected)
  const resolved = resolveImport(target, base)
  if (!resolved.startsWith('file:')) return canonicalFile(resolved, selected)
  const url = new URL(resolved)
  if (url.hostname || url.search || url.hash) throw new TypeError('Expected an unqualified local package entrypoint')
  return canonicalFile(fileURLToPath(url), selected)
}
