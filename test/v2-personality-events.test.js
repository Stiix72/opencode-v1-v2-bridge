import test from 'node:test'
import assert from 'node:assert/strict'
import { mapV2PersonalityEvent, PersonalityEventMappingError } from '../src/v2-personality-events.js'
import { registerLegacyEvents } from '../src/legacy-event-bridge.js'

const event = (role = 'assistant') => ({ type: 'message.updated', properties: { info: { id: 'm1', role, sessionID: 's1' }, extra: { future: true } } })

test('maps message.updated without dropping or mutating properties', () => {
  const input = event()
  const result = mapV2PersonalityEvent(input)
  assert.equal(result.type, input.type)
  assert.equal(result.properties, input.properties)
  assert.deepEqual(input.properties.extra, { future: true })
})
test('preserves user and assistant message roles', () => {
  for (const role of ['user', 'assistant']) assert.equal(mapV2PersonalityEvent(event(role)).properties.info.role, role)
})
test('skips unknown events without interpreting their payloads', () => {
  assert.equal(mapV2PersonalityEvent({ type: 'session.updated', properties: null }), null)
})
test('rejects invalid event envelopes rather than silently skipping', () => {
  for (const input of [null, [], 5, {}, { type: '' }, { type: 123 }]) {
    assert.throws(() => mapV2PersonalityEvent(input), PersonalityEventMappingError)
  }
})
test('rejects message.updated without valid properties or info', () => {
  for (const properties of [null, [], {}, { info: null }, { info: [] }, { info: { id: 'm1' } }, { info: { id: '', role: 'assistant' } }, { info: { id: 3, role: 'assistant' } }]) {
    assert.throws(() => mapV2PersonalityEvent({ type: 'message.updated', properties }), PersonalityEventMappingError)
  }
})
test('integration: delivers only mapped message events to legacy callback', async () => {
  const input = [ { type: 'session.updated', properties: {} }, event('user'), event('assistant') ]
  const seen = []
  const ctx = { event: { subscribe: () => ({ async *[Symbol.asyncIterator]() { yield* input } }) } }
  const subscription = await registerLegacyEvents(ctx, ({ event }) => { seen.push(event.properties.info.role) }, { mapEvent: mapV2PersonalityEvent })
  await subscription.done
  await subscription.dispose()
  assert.deepEqual(seen, ['user', 'assistant'])
})
