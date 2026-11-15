import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeLegacyCommand, executeAndDeliverLegacyCommand, LegacyCommandBridgeError } from '../src/legacy-command-bridge.js'
const input = { command: 'mood', sessionID: 'session-1', arguments: 'happy' }

test('captures V1 command text without invoking model', async () => {
  const parts = await invokeLegacyCommand(async (i, o) => {
    assert.equal(i.arguments, 'happy')
    o.parts.push({ type: 'text', text: 'Mood set to happy' })
  }, input)
  assert.deepEqual(parts, [{ type: 'text', text: 'Mood set to happy' }])
})

test('preserves existing parts and does not mutate caller array', async () => {
  const initialParts = [{ type: 'text', text: 'existing' }]
  const parts = await invokeLegacyCommand(async (_, o) => o.parts.push({ type: 'text', text: 'next' }), input, { initialParts })
  assert.equal(parts.length, 2)
  assert.equal(initialParts.length, 1)
})

test('preserves unknown non-text parts for host-specific delivery', async () => {
  const parts = await invokeLegacyCommand(async (_, o) => o.parts.push({ type: 'file', mime: 'image/png', url: 'file:///tmp/a.png' }), input)
  assert.equal(parts[0].type, 'file')
})

test('rejects malformed legacy output', async () => {
  await assert.rejects(invokeLegacyCommand(async (_, o) => o.parts.push({ type: 'text', text: 42 }), input), LegacyCommandBridgeError)
})

test('refuses to run state-changing command without output delivery', async () => {
  let calls = 0
  await assert.rejects(executeAndDeliverLegacyCommand(async () => { calls++ }, input), /not configured/)
  assert.equal(calls, 0)
})

test('delivers exact captured parts with session identity', async () => {
  const delivered = []
  await executeAndDeliverLegacyCommand(async (_, o) => o.parts.push({ type: 'text', text: 'hello' }), input, { deliver: x => delivered.push(x) })
  assert.deepEqual(delivered, [{ sessionID: 'session-1', command: 'mood', parts: [{ type: 'text', text: 'hello' }] }])
})

test('does not retry command after delivery failure', async () => {
  let calls = 0
  await assert.rejects(executeAndDeliverLegacyCommand(async (_, o) => {
    calls++
    o.parts.push({ type: 'text', text: 'updated' })
  }, input, { deliver: () => { throw new Error('UI unavailable') } }), /do not retry automatically/)
  assert.equal(calls, 1)
})

test('propagates legacy hook errors without delivering', async () => {
  let delivered = false
  await assert.rejects(executeAndDeliverLegacyCommand(async () => { throw new Error('legacy failure') }, input, { deliver: () => { delivered = true } }), /legacy failure/)
  assert.equal(delivered, false)
})

test('rejects sparse initial command parts', async () => {
  const parts = new Array(1)
  await assert.rejects(invokeLegacyCommand(async () => {}, input, { initialParts: parts }), LegacyCommandBridgeError)
})

test('rejects sparse parts produced by a legacy hook', async () => {
  await assert.rejects(invokeLegacyCommand(async (_, output) => { output.parts = new Array(2) }, input), LegacyCommandBridgeError)
})
