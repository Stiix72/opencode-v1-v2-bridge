import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeV2BridgeDefinition } from '../src/v2-plugin-entrypoint.js'
import { planV2LegacyBridge, activateV2LegacyBridge } from '../src/v2-bridge-composition.js'

async function fixture(source, callback) {
  const dir = await mkdtemp(join(tmpdir(), 'v1-m1-'))
  try {
    await writeFile(join(dir, 'legacy.mjs'), source)
    return await callback(dir)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('native setup maps location.directory and returns idempotent cleanup', async () => fixture(
  'export default async input => { if (!input.directory || input.directory !== input.worktree) throw Error("directory mismatch"); return {} }',
  async dir => {
    const def = createNativeV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir,
      legacyClient: () => ({}), bindings: {} })
    const cleanup = await def.setup({ location: { directory: dir } })
    assert.equal(typeof cleanup, 'function')
    const first = cleanup()
    assert.equal(first, cleanup())
    await first
    const next = await def.setup({ location: { directory: dir } })
    assert.notEqual(next, cleanup)
    await next()
  },
))

test('native setup fails closed on missing location without poisoning a new host activation', async () => fixture(
  'export default async () => ({})',
  async dir => {
    const def = createNativeV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir, legacyClient: () => ({}), bindings: {} })
    await assert.rejects(def.setup({}), /Native V2 setup failed/)
    const cleanup = await def.setup({location:{directory:dir}})
    await cleanup()
  },
))

test('native default supplies a real input provider and still rejects missing native ownership', async () => {
  const def=createNativeV2BridgeDefinition({ targets: ['x'], bindings: {} })
  await assert.rejects(def.setup({}), /Native V2 setup failed/)
})

test('composition disposes command and system registrations exactly once', async () => {
  const disposed = []
  const hook = async () => {}
  const plugin = { id: 'one', hooks: { 'command.execute.before': hook, 'experimental.chat.system.transform': hook } }
  const ctx = {
    command: { transform: async () => ({ dispose: async () => { disposed.push('command') } }) },
    session: { hook: async () => ({ dispose: async () => { disposed.push('system') } }) },
  }
  const active = await activateV2LegacyBridge(planV2LegacyBridge(ctx, [plugin], {
    commandEntries: () => [{ name: 'mood', hook }], decodeCommand: () => ({}),
    deliverCommand: () => {}, mapSystemInput: () => ({}),
  }))
  await active.dispose()
  await active.dispose()
  assert.deepEqual(disposed, ['system', 'command'])
})

test('composition rolls back prior command registration on later host failure', async () => {
  let disposed = 0
  const hook = async () => {}
  const plugin = { id: 'one', hooks: { 'command.execute.before': hook, 'experimental.chat.system.transform': hook } }
  const ctx = {
    command: { transform: async () => ({ dispose: async () => { disposed++ } }) },
    session: { hook: async () => { throw Error('host failed') } },
  }
  await assert.rejects(activateV2LegacyBridge(planV2LegacyBridge(ctx, [plugin], {
    commandEntries: () => [{ name: 'mood', hook }], decodeCommand: () => ({}),
    deliverCommand: () => {}, mapSystemInput: () => ({}),
  })), /activation failed/)
  assert.equal(disposed, 1)
})

test('composition rejects nondisposable registration rather than claiming cleanup', async () => {
  const hook = async () => {}
  const ctx = { session: { hook: async () => 'undisposable' } }
  await assert.rejects(activateV2LegacyBridge(planV2LegacyBridge(ctx, [
    { id: 'one', hooks: { 'experimental.chat.system.transform': hook } },
  ], { mapSystemInput: () => ({}) })), /activation failed/)
})
