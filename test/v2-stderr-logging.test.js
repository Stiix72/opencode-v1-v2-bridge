import test from 'node:test'
import assert from 'node:assert/strict'
import { createStderrLegacyLogger } from '../src/v2-stderr-logging.js'

test('explicit stderr logger writes a structured line without host client or chat', async () => {
  const lines = []
  const logger = createStderrLegacyLogger({ write: line => lines.push(line) })
  assert.equal(await logger({ body: { service: 'personality-plugin', level: 'info', message: 'Mood set' } }), undefined)
  assert.deepEqual(lines.map(JSON.parse), [{ service: 'personality-plugin', level: 'info', message: 'Mood set' }])
})
test('stderr logger rejects invalid requests without writing', async () => {
  const lines = []
  const logger = createStderrLegacyLogger({ write: line => lines.push(line) })
  await assert.rejects(logger({ body: { message: 'x' } }), /service, level, message/)
  assert.deepEqual(lines, [])
  assert.throws(() => createStderrLegacyLogger({ write: true }), /write/)
})
test('stderr write failures propagate to legacy caller', async () => {
  const logger = createStderrLegacyLogger({ write: () => { throw Error('broken stream') } })
  await assert.rejects(logger({ body: { service: 'p', level: 'error', message: 'x' } }), /broken stream/)
})

test('native RPC bridge exposes explicit stderr logging opt-in without inventing ctx.client', async () => {
  const { createRpcDeliveredNativeV2BridgeDefinition } = await import('../src/v2-rpc-native-bridge.js')
  assert.throws(() => createRpcDeliveredNativeV2BridgeDefinition({ stderrLog: true, hostLog() {} }), /either stderrLog or hostLog/)
  assert.throws(() => createRpcDeliveredNativeV2BridgeDefinition({ stderrLog: true, makeLegacyInput() {} }), /cannot override/)
  assert.equal(createRpcDeliveredNativeV2BridgeDefinition({ stderrLog: true }).id, 'opencode-v1-bridge')
})
