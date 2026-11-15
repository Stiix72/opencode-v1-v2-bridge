import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createV2BridgeDefinition, V2PluginEntrypointError } from '../src/v2-plugin-entrypoint.js'

async function fixture(source, run) {
  const dir = await mkdtemp(join(tmpdir(), 'v1-bridge-entry-'))
  try {
    const path = join(dir, 'legacy.mjs')
    await writeFile(path, source)
    await run({ dir, path })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
const input = () => ({ directory: '/test', worktree: '/test', client: {} })

test('factory returns V2 definition with id and setup', () => {
  const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], makeLegacyInput: input, bindings: {} })
  assert.equal(def.id, 'opencode-v1-bridge')
  assert.equal(typeof def.setup, 'function')
  assert.equal(Object.isFrozen(def), true)
})

test('rejects missing targets, input providers, bindings, and duplicates', () => {
  assert.throws(() => createV2BridgeDefinition({ targets: [], makeLegacyInput: input, bindings: {} }), /targets/)
  assert.throws(() => createV2BridgeDefinition({ targets: ['x'], bindings: {} }), /input provider/)
  assert.throws(() => createV2BridgeDefinition({ targets: ['x'], makeLegacyInput: input }), /bindings/)
  assert.throws(() => createV2BridgeDefinition({ targets: ['x','x'], makeLegacyInput: input, bindings: {} }), /Duplicate/)
})

test('loads and activates a V1 factory from an explicit relative path', async () => fixture(
  'export default async function(input) { if (!input.directory) throw Error("missing directory"); return {} }',
  async ({dir}) => {
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir, makeLegacyInput: input, bindings: {} })
    const result = await def.setup({})
    assert.deepEqual(result.commands, [])
    await result.dispose()
  },
))

test('supports a real client adapter through createLegacyInput', async () => fixture(
  'export default async function(input) { await input.client.app.log({message:"hello"}); return {} }',
  async ({dir}) => {
    let logged = false
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir,
      legacyClient: () => ({ log: async () => { logged = true } }), bindings: {} })
    await def.setup({directory: dir})
    assert.equal(logged, true)
  },
))

test('refuses partial activation when one legacy plugin fails', async () => fixture(
  'export default async () => ({})',
  async ({dir}) => {
    let activated = false
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs','./missing.mjs'], baseDirectory: dir,
      makeLegacyInput: input, bindings: {}, onActivated: () => { activated = true } })
    await assert.rejects(def.setup({}), error => {
      assert.ok(error instanceof V2PluginEntrypointError)
      assert.match(error.message, /partial activation/)
      assert.equal(error.cause.errors.length, 1)
      return true
    })
    assert.equal(activated, false)
  },
))

test('native V2 definitions are rejected as legacy targets', async () => fixture(
  'export default { id:"native", setup() {} }',
  async ({dir}) => {
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir, makeLegacyInput: input, bindings: {} })
    await assert.rejects(def.setup({}), /partial activation/)
  },
))

test('preflight fails before registration for unsupported hooks', async () => fixture(
  'export default async () => ({ "tool.execute.before": async () => {} })',
  async ({dir}) => {
    let called = false
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir, makeLegacyInput: input, bindings: {} })
    await assert.rejects(def.setup({tool:{transform:()=>{called=true}}}), /activation failed/)
    assert.equal(called, false)
  },
))

test('activation callback failure disposes acquired subscriptions', async () => fixture(
  'export default async () => ({ event: async () => {} })',
  async ({dir}) => {
    let closed = false
    const ctx = {event:{subscribe:()=>({[Symbol.asyncIterator](){return {
      next:async()=>({done:true}),return:async()=>{closed=true;return {done:true}},
    }}})}}
    const def = createV2BridgeDefinition({ targets: ['./legacy.mjs'], baseDirectory: dir, makeLegacyInput: input,
      bindings:{mapEvent:()=>null}, onActivated:()=>{throw Error('callback failed')} })
    await assert.rejects(def.setup(ctx), /activation failed/)
    assert.equal(closed,true)
  },
))

test('audit: activation callback failure preserves original error when cleanup also fails', async () => fixture(
  'export default async () => ({ event: async () => {} })',
  async ({dir}) => {
    const ctx = {event:{subscribe:()=>({[Symbol.asyncIterator](){return {
      next:async()=>({done:true}), return:async()=>{throw Error('cleanup failed')},
    }}})}}
    const def = createV2BridgeDefinition({targets:['./legacy.mjs'],baseDirectory:dir,
      makeLegacyInput:input,bindings:{mapEvent:()=>null},onActivated:()=>{throw Error('activation callback failed')}})
    await assert.rejects(def.setup(ctx), error => {
      assert.ok(error.cause instanceof AggregateError)
      assert.match(String(error.cause.errors[0]), /activation callback failed/)
      assert.match(String(error.cause.errors[1]), /cleanup failed/)
      return true
    })
  },
))
