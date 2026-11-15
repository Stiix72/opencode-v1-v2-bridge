import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createV2027AssistantEventMapper } from '../src/v2-assistant-events.js'
import { V2EventMappingError } from '../src/v2-event-mapper.js'
import { registerLegacyEvents } from '../src/legacy-event-bridge.js'
import { planV2LegacyBridge, activateV2LegacyBridge } from '../src/v2-bridge-composition.js'

const examples = JSON.parse(readFileSync(new URL('./fixtures/host-v2.0.27/assistant-events.json', import.meta.url)))
const event = (name, change = {}) => ({ ...structuredClone(examples[name]), ...change })
const stream = items => ({ async *[Symbol.asyncIterator]() { yield* items } })
const second = () => { const e = event('ended'); e.id = 'evt_second'; e.durable.seq = 9; e.data.assistantMessageID = 'msg_second'; return e }

test('native terminal maps assistant identity and preserves detached native provenance', () => {
  const mapper = createV2027AssistantEventMapper()
  const input = event('ended')
  const output = mapper.mapEvent(input)
  assert.equal(output.type, 'message.updated')
  assert.deepEqual(output.properties.info, { id: 'msg_one', sessionID: 'ses_one', role: 'assistant',
    time: { completed: 1007 }, finish: 'stop', cost: 0, tokens: input.data.tokens })
  assert.deepEqual(output.properties.bridge.native, input)
  input.metadata.audit = 'changed'
  assert.equal(output.properties.bridge.native.metadata.audit, 'preserve')
  assert.equal('agent' in output.properties.info, false, 'Do not invent fields missing from a terminal event')
})

test('start, transparent retry, delta, text end and stream end do not emit updates', () => {
  const mapper = createV2027AssistantEventMapper()
  for (const key of ['started', 'retry', 'started', 'delta', 'delta', 'textEnded', 'streamed']) assert.equal(mapper.mapEvent(event(key)), null)
  assert.equal(mapper.snapshot().messages, 0)
  assert.equal(mapper.mapEvent(event('ended')).type, 'message.updated')
})

test('replayed terminal and overlapping failed/ended events deliver only once per message', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(event('ended'))
  assert.equal(mapper.mapEvent(event('ended')), null)
  const overlap = event('failed'); overlap.data.assistantMessageID = 'msg_one'
  assert.equal(mapper.mapEvent(overlap), null)
  assert.equal(mapper.mapEvent(second()).properties.info.id, 'msg_second')
  assert.equal(mapper.snapshot().messages, 2)
})

test('failed/interrupted terminal emits an assistant update with its original error', () => {
  const output = createV2027AssistantEventMapper().mapEvent(event('failed'))
  assert.equal(output.properties.info.finish, 'error')
  assert.deepEqual(output.properties.info.error, examples.failed.data.error)
})

test('failed terminal cannot be redelivered as success for the same message identity', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(event('failed'))
  const late = second(); late.data.assistantMessageID = 'msg_two'
  assert.equal(mapper.mapEvent(late), null)
})

test('the same message ID in different sessions is not deduplicated across sessions', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(event('ended'))
  const other = event('ended'); other.data.sessionID = other.durable.aggregateID = 'ses_other'
  assert.equal(mapper.mapEvent(other).properties.info.sessionID, 'ses_other')
})

test('missing start is supported; late create/start cannot reset terminal deduplication', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(event('ended'))
  assert.equal(mapper.mapEvent(event('created')), null)
  assert.equal(mapper.mapEvent(event('started')), null)
  assert.equal(mapper.mapEvent(event('ended')), null)
})

test('new reordered terminal fails explicitly, while a known old duplicate is ignored', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(second())
  assert.throws(() => mapper.mapEvent(event('ended')), /Reordered/)
  assert.equal(mapper.snapshot().messages, 1)
  assert.equal(mapper.mapEvent(second()), null)
})

test('session.created retains native data and emits once without personality assumptions', () => {
  const mapper = createV2027AssistantEventMapper()
  assert.deepEqual(mapper.mapEvent(event('created')), { type: 'session.created', properties: examples.created.data })
  assert.equal(mapper.mapEvent(event('created')), null)
  assert.ok(mapper.mapEvent(event('ended')))
})

test('session deletion clears message keys and retains a bounded late-event tombstone', () => {
  const mapper = createV2027AssistantEventMapper({ maxSessions: 1 })
  mapper.mapEvent(event('ended'))
  assert.equal(mapper.mapEvent(event('deleted')), null)
  assert.equal(mapper.snapshot().messages, 0)
  assert.equal(mapper.snapshot().tombstones, 1)
  assert.equal(mapper.mapEvent(event('ended')), null)
  assert.equal(mapper.mapEvent(event('created')), null)
  const other = event('ended'); other.data.sessionID = other.durable.aggregateID = 'ses_other'
  assert.throws(() => mapper.mapEvent(other), /capacity exhausted/)
  mapper.dispose(); mapper.dispose()
  assert.equal(mapper.snapshot().sessions, 0)
  assert.throws(() => mapper.mapEvent(event('ended')), /disposed/)
})

test('execution completion is not session deletion and cannot permit repeated drift', () => {
  const mapper = createV2027AssistantEventMapper()
  mapper.mapEvent(event('ended'))
  mapper.mapEvent(event('executionEnded'))
  assert.equal(mapper.mapEvent(event('ended')), null)
})

test('capacity limits fail closed without evicting earlier deduplication entries', () => {
  const mapper = createV2027AssistantEventMapper({ maxMessagesPerSession: 1 })
  mapper.mapEvent(event('ended'))
  assert.throws(() => mapper.mapEvent(second()), /capacity exhausted/)
  assert.equal(mapper.mapEvent(event('ended')), null)
  assert.equal(mapper.snapshot().messages, 1)
})

test('unsupported mappings require an explicit diagnostic policy; V1-shaped input is not native', () => {
  const mapper = createV2027AssistantEventMapper()
  assert.throws(() => mapper.mapEvent({ type: 'message.updated', properties: { info: {} } }), /Unsupported/)
  const diagnostics = []
  const accepting = createV2027AssistantEventMapper({ onUnsupported: d => { diagnostics.push(d) } })
  assert.equal(accepting.mapEvent({ type: 'provider.updated', data: {} }), null)
  assert.deepEqual(diagnostics, [{ type: 'provider.updated', reason: 'No V1 mapping is implemented' }])
  assert.equal(accepting.snapshot().unsupported, 1)
})

test('asynchronous unsupported-event reporter cannot create unobserved rejection or false acceptance', async () => {
  const mapper = createV2027AssistantEventMapper({ onUnsupported: async () => { throw Error('report failed') } })
  assert.throws(() => mapper.mapEvent({ type: 'unknown' }), /must complete synchronously/)
  await new Promise(resolve => setImmediate(resolve))
})

for (const [name, mutate] of [
  ['session ID', e => { delete e.data.sessionID }], ['message ID', e => { delete e.data.assistantMessageID }],
  ['aggregate identity', e => { e.durable.aggregateID = 'ses_wrong' }], ['sequence', e => { e.durable.seq = -1 }],
  ['version', e => { e.durable.version = 2 }], ['timestamp', e => { e.created = NaN }],
  ['event ID', e => { delete e.id }], ['finish', e => { delete e.data.finish }],
  ['tokens', e => { e.data.tokens.cache.read = 'wrong' }], ['cost', e => { e.data.cost = Infinity }],
  ['metadata', e => { e.metadata = [] }], ['data', e => { e.data = null }],
]) test(`malformed native ${name} cannot cause readiness or legacy delivery`, () => {
  const mapper = createV2027AssistantEventMapper()
  const input = event('ended'); mutate(input)
  assert.throws(() => mapper.mapEvent(input), V2EventMappingError)
  assert.equal(mapper.snapshot().mapped, 0)
  assert.equal(mapper.snapshot().messages, 0)
})

test('malformed failed events and invalid options fail explicitly', () => {
  const input = event('failed'); delete input.data.error
  assert.throws(() => createV2027AssistantEventMapper().mapEvent(input), /requires a native error/)
  for (const value of [0, -1, Infinity, 1.5]) assert.throws(() => createV2027AssistantEventMapper({ maxSessions: value }), TypeError)
  assert.throws(() => createV2027AssistantEventMapper({ onUnsupported: 1 }), TypeError)
})

test('native mapper uses existing ordered dispatcher and releases state at stream completion', async () => {
  const mapper = createV2027AssistantEventMapper(), seen = []
  const reg = await registerLegacyEvents({ event: { subscribe: () => stream([event('created'), event('ended'), event('ended'), event('failed')]) } },
    async ({ event: legacy }) => { seen.push(legacy) }, { mapEvent: mapper.mapEvent, disposeMapper: mapper.dispose })
  await reg.done
  assert.deepEqual(seen.map(e => e.type), ['session.created', 'message.updated', 'message.updated'])
  assert.equal(mapper.snapshot().closed, true)
  assert.equal(mapper.snapshot().sessions, 0)
  await reg.dispose()
})

test('composition creates independent translators for independent plugins', async () => {
  const mappers = [], seen = []
  const plugins = ['one', 'two'].map(id => ({ id, hooks: { event: async ({ event: legacy }) => { seen.push([id, legacy.properties.info.id]) } } }))
  const active = await activateV2LegacyBridge(planV2LegacyBridge({ event: { subscribe: () => stream([event('ended')]) } }, plugins, {
    createEventMapper() { const mapper = createV2027AssistantEventMapper(); mappers.push(mapper); return mapper },
    onEventError(error) { assert.fail(String(error)) },
  }))
  await Promise.all(active.events.map(reg => reg.done))
  assert.deepEqual(seen, [['one', 'msg_one'], ['two', 'msg_one']])
  await active.dispose()
  assert.ok(mappers.every(mapper => mapper.snapshot().closed))
})

test('composition rejects ambiguous or invalid mapper factories', async () => {
  const plugins = [{ hooks: { event() {} } }], ctx = { event: { subscribe: () => stream([]) } }
  assert.throws(() => planV2LegacyBridge(ctx, plugins, { mapEvent() {}, createEventMapper() {} }), /Choose either/)
  assert.throws(() => planV2LegacyBridge(ctx, plugins, { createEventMapper: () => ({}) }), /onEventError/)
  await assert.rejects(activateV2LegacyBridge(planV2LegacyBridge(ctx, plugins, { createEventMapper: () => ({}), onEventError() {} })), /activation failed/)
})

test('subscription setup failure disposes its owned translator', async () => {
  const mapper = createV2027AssistantEventMapper()
  await assert.rejects(registerLegacyEvents({ event: { subscribe: () => ({}) } }, () => {},
    { mapEvent: mapper.mapEvent, disposeMapper: mapper.dispose }), /async iterable/)
  assert.equal(mapper.snapshot().closed, true)
})

test('composition subscription setup errors still dispose the created mapper', async () => {
  let mapper
  await assert.rejects(activateV2LegacyBridge(planV2LegacyBridge({ event: { subscribe: () => ({}) } },
    [{ hooks: { event() {} } }], {
      createEventMapper: () => (mapper = createV2027AssistantEventMapper()), onEventError() {},
    })), /activation failed/)
  assert.equal(mapper.snapshot().closed, true)
})

test('composition reports a terminal mapping failure through the required reporter', async () => {
  const malformed = event('ended'); delete malformed.data.sessionID
  const errors = []
  const active = await activateV2LegacyBridge(planV2LegacyBridge({ event: { subscribe: () => stream([malformed]) } },
    [{ hooks: { event() { assert.fail('Malformed event reached plugin') } } }], {
      createEventMapper: () => createV2027AssistantEventMapper(), onEventError: error => { errors.push(error) },
    }))
  await assert.rejects(active.events[0].done, /durable envelope/)
  assert.equal(errors.length, 1); await assert.rejects(active.dispose(), error => error instanceof AggregateError && error.errors.some(e=>/durable envelope/.test(e.message)))
})

test('mapper cleanup failure cannot conceal the original callback error', async () => {
  const failure = Error('callback failed'), cleanup = Error('cleanup failed')
  const reg = await registerLegacyEvents({ event: { subscribe: () => stream([event('ended')]) } },
    () => { throw failure }, { mapEvent: createV2027AssistantEventMapper().mapEvent, disposeMapper: () => { throw cleanup } })
  await assert.rejects(reg.done, e => e instanceof AggregateError && e.errors[0] === failure && e.errors[1] === cleanup)
  await assert.rejects(reg.dispose(), e => e instanceof AggregateError && e.errors[0] === failure && e.errors[1] === cleanup)
})

test('asynchronous mapper cleanup is rejected rather than reported as completed', async () => {
  const reg = await registerLegacyEvents({ event: { subscribe: () => stream([]) } }, () => {},
    { mapEvent: () => null, disposeMapper: async () => {} })
  await assert.rejects(reg.done, /must complete synchronously/)
  await assert.rejects(reg.dispose(), /must complete synchronously/)
})

test('handler error closes translator and aborts subscription without retrying', async () => {
  const mapper = createV2027AssistantEventMapper(); let signal, calls = 0
  const failure = Error('plugin failed'), errors = []
  const reg = await registerLegacyEvents({ event: { subscribe: options => { signal = options.signal; return stream([event('ended'), second()]) } } },
    () => { calls++; throw failure }, { mapEvent: mapper.mapEvent, disposeMapper: mapper.dispose, onError: e => { errors.push(e) } })
  await assert.rejects(reg.done, e => e === failure)
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.equal(mapper.snapshot().closed, true)
  assert.deepEqual(errors, [failure]); await assert.rejects(reg.dispose(), e => e === failure)
})

test('disposal cancels pending input and prevents a late original callback', async () => {
  const mapper = createV2027AssistantEventMapper(); let resolve, signal, calls = 0
  const reg = await registerLegacyEvents({ event: { subscribe: options => {
    signal = options.signal
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(r => { resolve = r }), return: async () => ({ done: true }) }) }
  } } }, () => { calls++ }, { mapEvent: mapper.mapEvent, disposeMapper: mapper.dispose })
  const closing = reg.dispose(); resolve({ done: false, value: event('ended') })
  await closing
  assert.equal(signal.aborted, true); assert.equal(calls, 0); assert.equal(mapper.snapshot().sessions, 0)
})

test('uncooperative iterator timeout still clears owned deduplication state', async () => {
  const mapper = createV2027AssistantEventMapper(); mapper.mapEvent(event('ended')); let resolve
  const reg = await registerLegacyEvents({ event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({
    next: () => new Promise(r => { resolve = r }), return: () => new Promise(() => {}),
  }) }) } }, () => {}, { mapEvent: mapper.mapEvent, disposeMapper: mapper.dispose, disposeTimeoutMs: 10 })
  await assert.rejects(reg.dispose(), /did not stop/)
  assert.equal(mapper.snapshot().closed, true); assert.equal(mapper.snapshot().sessions, 0)
  resolve({ done: true }); await reg.done
})
