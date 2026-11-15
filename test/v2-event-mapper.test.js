import test from 'node:test'
import assert from 'node:assert/strict'
import { createV2EventMapper, V2EventMappingError, mapV2MessageUpdated } from '../src/v2-event-mapper.js'
import { mapV2PersonalityEvent } from '../src/v2-personality-events.js'
import { registerLegacyEvents } from '../src/legacy-event-bridge.js'

test('generic event mapper forwards unrelated named event types without modification', () => {
  const map = createV2EventMapper({ 'session.updated': p => typeof p.sessionID === 'string' })
  const event = { type: 'session.updated', properties: { sessionID: 's1', extension: { keep: true } } }
  const result = map(event)
  assert.equal(result.properties, event.properties)
  assert.equal(result.type, 'session.updated')
})
test('generic event mapper supports multiple event types with independent validators', () => {
  const map = createV2EventMapper({ 'session.updated': p => !!p.sessionID, 'tool.called': p => !!p.name })
  assert.equal(map({ type: 'tool.called', properties: { name: 't' } }).type, 'tool.called')
  assert.equal(map({ type: 'session.updated', properties: { sessionID: 's' } }).type, 'session.updated')
  assert.equal(map({ type: 'other', properties: {} }), null)
})
test('generic mapper rejects malformed recognized event and validator failure', () => {
  const map = createV2EventMapper({ 'tool.called': p => !!p.name })
  assert.throws(() => map({ type: 'tool.called', properties: {} }), V2EventMappingError)
  assert.throws(() => map({ type: 'tool.called', properties: [] }), V2EventMappingError)
  assert.throws(() => map({ type: 'tool.called' }), V2EventMappingError)
})
test('generic mapper does not swallow validator exceptions', () => {
  const cause = new Error('bad payload')
  const map = createV2EventMapper({ 'tool.called': () => { throw cause } })
  assert.throws(() => map({ type: 'tool.called', properties: {} }), error => error instanceof V2EventMappingError && error.cause === cause)
})
test('unknown events can be explicitly rejected', () => {
  const map = createV2EventMapper({ 'tool.called': () => true }, { onUnknown: 'reject' })
  assert.throws(() => map({ type: 'other', properties: {} }), V2EventMappingError)
})
test('invalid mapping configuration fails before event subscription', () => {
  for (const rules of [null, {}, [], { foo: 1 }, { '': () => true }]) {
    assert.throws(() => createV2EventMapper(rules), TypeError)
  }
  assert.throws(() => createV2EventMapper({ foo: () => true }, { onUnknown: 'guess' }), TypeError)
})
test('existing personality event mapping is an alias for the reusable message.updated preset', () => {
  assert.equal(mapV2PersonalityEvent, mapV2MessageUpdated)
})
test('two independent legacy plugins can reuse one generic event mapper', async () => {
  const seen = []
  const ctx = { event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'session.updated', properties: { sessionID: 's1' } }
  } }) } }
  const map = createV2EventMapper({ 'session.updated': p => !!p.sessionID })
  const a = await registerLegacyEvents(ctx, ({ event }) => seen.push(['a', event.properties.sessionID]), { mapEvent: map })
  const b = await registerLegacyEvents(ctx, ({ event }) => seen.push(['b', event.properties.sessionID]), { mapEvent: map })
  await Promise.all([a.done, b.done]); await Promise.all([a.dispose(), b.dispose()])
  assert.deepEqual(seen, [['a', 's1'], ['b', 's1']])
})
