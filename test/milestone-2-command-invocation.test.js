import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeV2CommandInvocation as decode, V2CommandInvocationError } from '../src/v2-command-invocation.js'
import { registerV2LegacyCommands } from '../src/v2-command-registration.js'

const invocation = (text = 'list') => ({ sessionID: 'session-1', prompt: { text }, delivery: 'queue' })
test('decodes documented V2 prompt.text as raw legacy arguments', () => {
  assert.deepEqual(decode(invocation('set --name "Test"'), 'personality'), {
    command: 'personality', sessionID: 'session-1', arguments: 'set --name "Test"',
  })
})
test('preserves empty arguments and steer delivery', () => {
  assert.equal(decode({ ...invocation(''), delivery: 'steer' }, 'mood').arguments, '')
})
test('refuses unverified string prompt shape', () => {
  assert.throws(() => decode({ ...invocation(), prompt: 'happy' }, 'mood'), V2CommandInvocationError)
})
test('refuses attachments rather than silently discarding them', () => {
  assert.throws(() => decode({ ...invocation(), prompt: { text: 'set', files: [{ uri: 'file:///x' }] } }, 'personality'), /attachments/)
})
test('refuses malformed session, delivery and command identities', () => {
  assert.throws(() => decode({ ...invocation(), sessionID: '' }, 'mood'), /sessionID/)
  assert.throws(() => decode({ ...invocation(), delivery: 'later' }, 'mood'), /delivery/)
  assert.throws(() => decode(invocation(), 'bad name'), /name/)
})
test('integrates decoded invocation with legacy command hook and explicit delivery', async () => {
  let execute, received
  const domain = { transform: async callback => {
    callback({ add: definition => { execute = definition.execute } })
    return { dispose() {} }
  } }
  await registerV2LegacyCommands(domain, [{ name: 'mood', hook: async (input, output) => {
    assert.equal(input.arguments, 'happy')
    output.parts.push({ type: 'text', text: 'Mood updated' })
  } }], { decode, deliver: result => { received = result } })
  await execute(invocation('happy'))
  assert.deepEqual(received, { sessionID: 'session-1', command: 'mood', parts: [{ type: 'text', text: 'Mood updated' }] })
})
test('rejects invalid invocation before invoking state-changing legacy hook', async () => {
  let execute, calls = 0
  const domain = { transform: async callback => {
    callback({ add: definition => { execute = definition.execute } })
    return { dispose() {} }
  } }
  await registerV2LegacyCommands(domain, [{ name: 'mood', hook() { calls++ } }], { decode, deliver() {} })
  await assert.rejects(execute({ ...invocation(), prompt: 'invalid' }), V2CommandInvocationError)
  assert.equal(calls, 0)
})
