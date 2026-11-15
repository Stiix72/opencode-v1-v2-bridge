import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPluginModule, inspectLegacyHooks } from '../src/legacy-contract.js'

test('V1 default factory', () => {
  const factory = async () => ({ tool: {} })
  assert.deepEqual(classifyPluginModule({ default: factory }), { kind: 'legacy-function', factory })
})
test('V1 object with server entry point', () => {
  const server = async () => ({})
  assert.deepEqual(classifyPluginModule({ default: { id: 'old', server } }), { kind: 'legacy-object', id: 'old', factory: server })
})
test('native V2 wins over legacy server on dual-export objects', () => {
  assert.deepEqual(classifyPluginModule({ default: { id: 'dual', server() {}, setup() {} } }), { kind: 'native-v2', id: 'dual' })
})
test('unsupported module fails closed', () => {
  assert.equal(classifyPluginModule({ default: { tools: {} } }).kind, 'unsupported')
})
test('recognizes personality hook contract', () => {
  const result = inspectLegacyHooks({
    tool: { setMood: { execute: async () => '' } },
    'command.execute.before': async () => {},
    'experimental.chat.system.transform': async () => {},
    event: async () => {},
  })
  assert.equal(result.recognized.length, 4)
  assert.deepEqual(result.unsupported, [])
})
test('unknown hooks are explicitly reported', () => {
  assert.deepEqual(inspectLegacyHooks({ 'chat.params': async () => {} }).unsupported, ['chat.params'])
})
test('invalid tool is rejected', () => {
  assert.throws(() => inspectLegacyHooks({ tool: { bad: { description: 'missing execute' } } }), /Invalid tool/)
})
