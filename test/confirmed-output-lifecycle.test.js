import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { registerConfirmedCommandOutput } from '../src/v2-command-output-receipts.js'

const request = (sessionID = 'session-a') => ({ sessionID, command: 'status', parts: [{ type: 'text', text: 'read-only output' }] })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
// The public host contract separates event publication from consumer processing:
// events.emit returns Promise<void>; receipt is a distinct later RPC method.
async function transport({ onPublish, receiptTimeoutMs = 1000 } = {}) {
  let methods, disposed = 0
  const events = []
  const output = await registerConfirmedCommandOutput({ rpc: { async register(_definition, handlers) {
    methods = handlers
    return { events: { async emit(name, data) { events.push({ name, data }); await onPublish?.(data, handlers) } },
      async dispose() { disposed++ } }
  } } }, { receiptTimeoutMs })
  return { output, events, get methods() { return methods }, get disposed() { return disposed } }
}

test('disposal before the publication microtask prevents stale output emission', async () => {
  const t = await transport()
  const failed = assert.rejects(t.output.deliver(request()), /disposed before receipt/)
  const first = t.output.dispose(), second = t.output.dispose()
  assert.equal(first, second)
  await first; await failed
  assert.equal(t.events.length, 0, 'Disposed activation must never publish queued output')
  assert.equal(t.disposed, 1)
})

test('expired output is not published when its timer runs before its publication microtask', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await transport({ receiptTimeoutMs: 10 })
  const failed = assert.rejects(h.output.deliver(request()), /receipt deadline/)
  t.mock.timers.tick(10)
  await failed
  assert.equal(h.events.length, 0)
  await h.output.dispose()
})

test('duplicate success receipts are refused while publication is still pending', async () => {
  const gate = deferred(), arrived = deferred()
  const h = await transport({ onPublish: async data => { arrived.resolve(data); await gate.promise } })
  const done = h.output.deliver(request()), data = await arrived.promise
  assert.deepEqual(await h.methods.receipt({ deliveryID: data.deliveryID, status: 'retained' }), { accepted: true })
  assert.deepEqual(await h.methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' }), { accepted: false })
  gate.resolve()
  assert.deepEqual(await done, { deliveryID: data.deliveryID, status: 'retained' })
  await h.output.dispose()
})

test('a failure receipt cannot be replaced by success in the same publication turn', async () => {
  const acknowledgments = []
  const h = await transport({ onPublish: async (data, methods) => {
    acknowledgments.push(await methods.receipt({ deliveryID: data.deliveryID, status: 'failed', error: 'UI unavailable' }))
    acknowledgments.push(await methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' }))
  } })
  await assert.rejects(h.output.deliver(request()), /UI unavailable/)
  assert.deepEqual(acknowledgments, [{ accepted: true }, { accepted: false }])
  await h.output.dispose()
})

for (const elapsed of [10, 11]) test('late receipt is refused at elapsed ' + elapsed + 'ms even before the timeout callback executes', async t => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const arrived = deferred()
  const h = await transport({ receiptTimeoutMs: 10, onPublish: data => { arrived.resolve(data) } })
  const failed = assert.rejects(h.output.deliver(request()), /receipt deadline/)
  const data = await arrived.promise
  // No timer tick: the event loop may deliver an RPC callback before an overdue timer.
  now += elapsed
  assert.deepEqual(await h.methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' }), { accepted: false })
  await failed
  await h.output.dispose()
})

test('a receipt just before the monotonic deadline still succeeds', async t => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const arrived = deferred()
  const h = await transport({ receiptTimeoutMs: 10, onPublish: data => { arrived.resolve(data) } })
  const done = h.output.deliver(request()), data = await arrived.promise
  now = 109
  assert.deepEqual(await h.methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' }), { accepted: true })
  assert.equal((await done).status, 'displayed')
  await h.output.dispose()
})

test('an event-loop stall before publication does not emit expired output', async t => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const h = await transport({ receiptTimeoutMs: 10 })
  const failed = assert.rejects(h.output.deliver(request()), /receipt deadline/)
  now = 110
  await failed
  assert.equal(h.events.length, 0)
  await h.output.dispose()
})

test('receipt correlation remains independent for concurrent sessions', async () => {
  const arrivals = deferred()
  const h = await transport({ onPublish: () => { if (h.events.length === 2) arrivals.resolve() } })
  const a = h.output.deliver(request('session-a')), b = h.output.deliver(request('session-b'))
  await arrivals.promise
  const [first, second] = h.events.map(event => event.data)
  assert.notEqual(first.deliveryID, second.deliveryID)
  assert.deepEqual(await h.methods.receipt({ deliveryID: 'unknown', status: 'displayed' }), { accepted: false })
  await h.methods.receipt({ deliveryID: second.deliveryID, status: 'retained' })
  await h.methods.receipt({ deliveryID: first.deliveryID, status: 'displayed' })
  assert.deepEqual(await a, { deliveryID: first.deliveryID, status: 'displayed' })
  assert.deepEqual(await b, { deliveryID: second.deliveryID, status: 'retained' })
  await h.output.dispose()
})

test('a receipt never hides a publication failure or starts a retry', async () => {
  const h = await transport({ onPublish: async (data, methods) => {
    await methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' })
    throw Error('host publication failed')
  } })
  await assert.rejects(h.output.deliver(request()), /host publication failed/)
  assert.equal(h.events.length, 1)
  await h.output.dispose()
})

test('registration cleanup failures remain observable and cleanup is not repeated', async () => {
  let disposed = 0
  const failure = Error('host cleanup failed')
  const output = await registerConfirmedCommandOutput({ rpc: { async register() {
    return { events: { async emit() {} }, async dispose() { disposed++; throw failure } }
  } } })
  const first = output.dispose(), second = output.dispose()
  assert.equal(first, second)
  await assert.rejects(first, error => error.errors.includes(failure))
  await assert.rejects(output.dispose(), error => error.errors.includes(failure))
  assert.equal(disposed, 1)
})

test('empty output remains a no-publication result', async () => {
  const h = await transport()
  assert.deepEqual(await h.output.deliver({ ...request(), parts: [] }), { status: 'empty' })
  assert.equal(h.events.length, 0)
  await h.output.dispose()
})

test('a valid receipt does not make publication completed after deadline successful', async t => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const h = await transport({ receiptTimeoutMs: 10, onPublish: async (data, methods) => {
    assert.deepEqual(await methods.receipt({ deliveryID: data.deliveryID, status: 'displayed' }), { accepted: true })
    now = 110
  } })
  await assert.rejects(h.output.deliver(request()), /receipt deadline/)
  assert.equal(h.events.length, 1, 'Already-entered publication cannot be recalled or retried')
  await h.output.dispose()
})

test('wall-clock adjustments do not change the monotonic delivery deadline', async t => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER)
  const h = await transport({ receiptTimeoutMs: 10, onPublish: async (data, methods) => {
    now = 109
    assert.deepEqual(await methods.receipt({ deliveryID: data.deliveryID, status: 'retained' }), { accepted: true })
  } })
  assert.equal((await h.output.deliver(request())).status, 'retained')
  await h.output.dispose()
})
