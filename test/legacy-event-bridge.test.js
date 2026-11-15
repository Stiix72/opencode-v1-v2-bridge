import test from 'node:test'
import assert from 'node:assert/strict'
import { registerLegacyEvents, validateLegacyEvent, LegacyEventBridgeError } from '../src/legacy-event-bridge.js'

function stream(items, { onReturn } = {}) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() { return i < items.length ? { value: items[i++], done: false } : { done: true } },
        async return() { onReturn?.(); return { done: true } },
      }
    },
  }
}
const mapper = value => ({ type: value.kind, properties: value.payload })

test('converts V2 event into V1 wrapper and preserves order', async () => {
  const seen = []
  const ctx = { event: { subscribe: () => stream([{ kind: 'message.updated', payload: { id: '1' } }, { kind: 'message.updated', payload: { id: '2' } }]) } }
  const reg = await registerLegacyEvents(ctx, async ({ event }) => { seen.push(event.properties.id) }, { mapEvent: mapper })
  await reg.done
  assert.deepEqual(seen, ['1', '2'])
  await reg.dispose()
})

test('mapper can explicitly skip unmappable events', async () => {
  const seen = []
  const ctx = { event: { subscribe: () => stream([{ kind: 'unknown' }, { kind: 'message.updated', payload: {} }]) } }
  const reg = await registerLegacyEvents(ctx, async ({ event }) => seen.push(event.type), {
    mapEvent: value => value.kind === 'unknown' ? null : mapper(value),
  })
  await reg.done
  assert.deepEqual(seen, ['message.updated'])
  await reg.dispose()
})

test('requires an explicit event mapper and available host capability', async () => {
  await assert.rejects(registerLegacyEvents({}, async () => {}, { mapEvent: mapper }), /unavailable/)
  let subscribed = false
  await assert.rejects(registerLegacyEvents({ event: { subscribe: () => { subscribed = true } } }, async () => {}), /mapper is required/)
  assert.equal(subscribed, false)
})

test('rejects malformed mapped events before invoking handler', async () => {
  let called = false
  const ctx = { event: { subscribe: () => stream([{ kind: 'x' }]) } }
  const reg = await registerLegacyEvents(ctx, async () => { called = true }, { mapEvent: mapper })
  await assert.rejects(reg.done, LegacyEventBridgeError)
  assert.equal(called, false)
  await assert.rejects(reg.dispose(), LegacyEventBridgeError)
})

test('handler failures propagate and are reported', async () => {
  const failure = new Error('disk write failed')
  const errors = []
  const ctx = { event: { subscribe: () => stream([{ kind: 'message.updated', payload: {} }]) } }
  const reg = await registerLegacyEvents(ctx, async () => { throw failure }, { mapEvent: mapper, onError: error => errors.push(error) })
  await assert.rejects(reg.done, /disk write failed/)
  assert.deepEqual(errors, [failure])
  await assert.rejects(reg.dispose(), /disk write failed/)
})

test('subscription failures propagate without invoking legacy hooks', async () => {
  const ctx = { event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('stream disconnected') } }) }) } }
  const errors = []
  const reg = await registerLegacyEvents(ctx, async () => { throw new Error('unexpected hook') }, { mapEvent: mapper, onError: error => errors.push(error) })
  await assert.rejects(reg.done, /stream disconnected/)
  assert.equal(errors.length, 1)
  await assert.rejects(reg.dispose(), /stream disconnected/)
})

test('dispose aborts the subscription and calls iterator.return', async () => {
  let signal, returned = 0
  const ctx = { event: { subscribe: options => {
    signal = options.signal
    return stream([], { onReturn: () => returned++ })
  } } }
  const reg = await registerLegacyEvents(ctx, async () => {}, { mapEvent: mapper })
  await reg.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(returned, 1)
  await reg.dispose()
  assert.equal(returned, 1)
})

test('refuses invalid subscriptions and malformed V1 events', async () => {
  await assert.rejects(registerLegacyEvents({ event: { subscribe: () => ({}) } }, async () => {}, { mapEvent: mapper }), /async iterable/)
  assert.throws(() => validateLegacyEvent({ type: 'x', properties: [] }), LegacyEventBridgeError)
})

test('dispose reports an unresponsive event stream instead of hanging forever', async () => {
  let resolveNext
  let aborted
  const ctx = { event: { subscribe: ({ signal }) => {
    aborted = signal
    return { [Symbol.asyncIterator]() { return {
      next: () => new Promise(resolve => { resolveNext = resolve }),
      return: () => new Promise(() => {}),
    } } }
  } } }
  const reg = await registerLegacyEvents(ctx, async () => {}, { mapEvent: mapper, disposeTimeoutMs: 15 })
  await assert.rejects(reg.dispose(), /did not stop within 15ms/)
  assert.equal(aborted.aborted, true)
  await assert.rejects(reg.dispose(), /did not stop within 15ms/)
  resolveNext({ done: true })
  await reg.done
})

test('dispose rejects invalid timeout before subscribing', async () => {
  let called = false
  const ctx = { event: { subscribe: () => { called = true } } }
  await assert.rejects(registerLegacyEvents(ctx, async () => {}, { mapEvent: mapper, disposeTimeoutMs: 0 }), /positive integer/)
  assert.equal(called, false)
})


test('handler failure aborts host event subscription without requiring explicit dispose', async () => {
  let signal
  const ctx = { event: { subscribe: options => {
    signal = options.signal
    return stream([{ kind: 'message.updated', payload: {} }])
  } } }
  const reg = await registerLegacyEvents(ctx, async () => { throw new Error('legacy callback failed') }, { mapEvent: mapper })
  await assert.rejects(reg.done, /legacy callback failed/)
  assert.equal(signal.aborted, true, 'failed handler must not leave the host subscription active')
  await assert.rejects(reg.dispose(), /legacy callback failed/)
})


test('async onError rejection is observed without masking the original failure', async () => {
  const failure = new Error('original handler failure')
  const ctx = { event: { subscribe: () => stream([{ kind: 'message.updated', payload: {} }]) } }
  const reg = await registerLegacyEvents(ctx, async () => { throw failure }, {
    mapEvent: mapper,
    onError: async () => { throw new Error('async reporting failure') },
  })
  await assert.rejects(reg.done, error => error === failure)
  await assert.rejects(reg.dispose(), error => error === failure)
  // An unhandled rejection would fail Node's test runner after this test.
  await new Promise(resolve => setImmediate(resolve))
})

test('handler failure remains observable when disposal races an in-flight callback', async () => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('callback failed during shutdown')
  const ctx = { event: { subscribe: () => stream([{ kind: 'message.updated', payload: {} }]) } }
  const reg = await registerLegacyEvents(ctx, async () => {
    entered()
    await gate
    throw failure
  }, { mapEvent: mapper })
  await started
  const shutdown = reg.dispose()
  release()
  await assert.rejects(reg.done, error => error === failure)
  await assert.rejects(shutdown, error => error === failure)
})


test('audit: invalid subscription iterator invokes return before rejecting', async () => {
  let returned = 0
  const ctx = { event: { subscribe: () => ({
    [Symbol.asyncIterator]: () => ({ return: async () => { returned++ } }),
  }) } }
  await assert.rejects(registerLegacyEvents(ctx, async () => {}, { mapEvent: mapper }), /invalid iterator/)
  assert.equal(returned, 1)
})

test('audit: invalid iterator cleanup cannot hang registration indefinitely', async () => {
  let signal
  const ctx = { event: { subscribe: ({ signal: s }) => {
    signal = s
    return { [Symbol.asyncIterator]: () => ({ return: () => new Promise(() => {}) }) }
  } } }
  await assert.rejects(registerLegacyEvents(ctx, async () => {}, { mapEvent: mapper, disposeTimeoutMs: 15 }), error => {
    assert.ok(error instanceof AggregateError);assert.match(error.errors[0].message,/invalid iterator/)
    assert.equal(error.errors[1].code,'cleanup-timeout');assert.ok(error.errors[1].cleanupDone instanceof Promise);return true
  })
  assert.equal(signal.aborted, true)
})
