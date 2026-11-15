import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assembleLegacyToolRegistry, applyLegacyToolSnapshot } from '../src/legacy-tool-registry.js'
const schema = { type: 'object', properties: {} }
const plugin = (id, names) => ({ id, hooks: { tool: Object.fromEntries(names.map(name => [name, { args: schema, execute: async () => id }])) } })
const invocation = { sessionID: 's', messageID: 'm', agent: 'build', directory: resolve('/tmp/test') }

test('stages multiple plugins and retains legacy callbacks', async () => {
  const result = await assembleLegacyToolRegistry([plugin('a', ['alpha']), plugin('b', ['beta'])])
  assert.deepEqual(Object.keys(result.tools), ['alpha', 'beta'])
  assert.equal(await result.tools.beta.execute({}, invocation), 'b')
  assert.equal(result.failures.length, 0)
})
test('does not overwrite earlier legacy tools on collisions', async () => {
  const result = await assembleLegacyToolRegistry([plugin('a', ['same']), plugin('b', ['same', 'other'])])
  assert.deepEqual(Object.keys(result.tools), ['same'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].plugin, 'b')
})
test('native V2 names are reserved', async () => {
  const result = await assembleLegacyToolRegistry([plugin('legacy', ['native'])], { nativeNames: ['native'] })
  assert.deepEqual(Object.keys(result.tools), [])
  assert.match(result.failures[0].error.message, /native-v2/)
})
test('schema conversion failure rolls back entire plugin', async () => {
  const p = plugin('broken', ['good', 'bad'])
  p.hooks.tool.bad.args = { _def: {} }
  const result = await assembleLegacyToolRegistry([p, plugin('working', ['ok'])])
  assert.deepEqual(Object.keys(result.tools), ['ok'])
  assert.equal(result.failures.length, 1)
})
test('plugins without tools are allowed', async () => {
  const result = await assembleLegacyToolRegistry([{ id: 'events', hooks: { event: async () => {} } }])
  assert.equal(result.accepted.length, 1)
  assert.deepEqual(result.accepted[0].tools, [])
})
test('context mapper is forwarded per plugin and invocation', async () => {
  const result = await assembleLegacyToolRegistry([plugin('one', ['x'])], {
    makeContext: (v, name, p) => ({ ...v, agent: `${p.id}-${name}` }),
  })
  assert.equal(result.tools.x.name, 'x')
  assert.equal(result.failures.length, 0)
})
test('destination collision aborts before any mutation', async () => {
  const snapshot = await assembleLegacyToolRegistry([plugin('a', ['alpha', 'beta'])])
  const destination = { beta: { native: true } }
  assert.throws(() => applyLegacyToolSnapshot(snapshot, destination, d => d), /already exists/)
  assert.deepEqual(Object.keys(destination), ['beta'])
})
test('definition conversion failure aborts before mutation', async () => {
  const snapshot = await assembleLegacyToolRegistry([plugin('a', ['alpha', 'beta'])])
  const destination = {}
  assert.throws(() => applyLegacyToolSnapshot(snapshot, destination, (d, name) => {
    if (name === 'beta') throw new Error('conversion failed')
    return d
  }), /conversion failed/)
  assert.deepEqual(Object.keys(destination), [])
})
test('snapshot catalog and descriptors cannot be reassigned', async () => {
  const snapshot = await assembleLegacyToolRegistry([plugin('a', ['alpha'])])
  assert.equal(Object.isFrozen(snapshot.tools), true)
  assert.equal(Object.isFrozen(snapshot.tools.alpha), true)
})
