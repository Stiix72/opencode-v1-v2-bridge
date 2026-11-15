import test from 'node:test'
import assert from 'node:assert/strict'
import { createV2LegacyClient, makeV2LegacyClient, V2ClientBindingError } from '../src/v2-client-bindings.js'
import { createV2BridgeDefinition } from '../src/v2-plugin-entrypoint.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ctx = () => ({client: {
  app: { requests: [], async log(payload) { this.requests.push(payload); return {ok: true} } },
  tui: { requests: [], async showToast(payload) { this.requests.push(payload); return {shown: true} } },
}})

test('forwards original log and toast payloads without rewriting them', async () => {
  const host = ctx(), client = createV2LegacyClient(host)
  const log = {body:{message:'x'}, query:{directory:'/tmp'}}, toast = {body:{message:'hi',variant:'info'}}
  assert.deepEqual(await client.log(log), {ok:true})
  assert.deepEqual(await client.showToast(toast), {shown:true})
  assert.strictEqual(host.client.app.requests[0], log)
  assert.strictEqual(host.client.tui.requests[0], toast)
})
test('methods remain bound to their original client owners', async () => {
  const host = ctx(), {log, showToast} = makeV2LegacyClient(host)
  await log({a:1}); await showToast({b:2})
  assert.equal(host.client.app.requests.length,1)
  assert.equal(host.client.tui.requests.length,1)
})
test('fails closed when app.log is absent', () => {
  const host = ctx(); delete host.client.app.log
  assert.throws(() => createV2LegacyClient(host), V2ClientBindingError)
})
test('fails closed when tui.showToast is absent', () => {
  const host = ctx(); delete host.client.tui.showToast
  assert.throws(() => createV2LegacyClient(host), /showToast/)
})
test('rejects absent host context and invalid shell', () => {
  assert.throws(() => createV2LegacyClient(null), /context/)
  assert.throws(() => createV2LegacyClient(ctx(), {shell: true}), /shell/)
})
test('optional shell is passed through unchanged', () => {
  const shell = () => 42
  assert.strictEqual(createV2LegacyClient(ctx(), {shell}).shell, shell)
})
test('legacy factory can use both host client methods through native V2 definition', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-client-'))
  try {
    await writeFile(join(dir,'plugin.mjs'), 'export default async ({client}) => { await client.app.log({body:{message:"hello"}}); await client.tui.showToast({body:{message:"hi"}}); return {} }')
    const host = {...ctx(),directory:dir,worktree:dir}
    const plugin = createV2BridgeDefinition({targets:['./plugin.mjs'],baseDirectory:dir,legacyClient:makeV2LegacyClient,bindings:{}})
    const result = await plugin.setup(host)
    assert.equal(host.client.app.requests.length,1)
    assert.equal(host.client.tui.requests.length,1)
    await result.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})
test('missing native client capability rejects setup before legacy factory executes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-client-'))
  try {
    await writeFile(join(dir,'plugin.mjs'), 'export default async () => { throw Error("factory executed") }')
    const host = {...ctx(),directory:dir,worktree:dir}
    delete host.client.tui.showToast
    const plugin = createV2BridgeDefinition({targets:['./plugin.mjs'],baseDirectory:dir,legacyClient:makeV2LegacyClient,bindings:{}})
    await assert.rejects(plugin.setup(host), err => {
      assert.match(err.message,/partial activation/)
      assert.doesNotMatch(JSON.stringify(err),/factory executed/)
      return true
    })
  } finally { await rm(dir,{recursive:true,force:true}) }
})
