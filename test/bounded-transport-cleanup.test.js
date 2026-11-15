import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerRpcCommandOutput } from '../src/v2-rpc-command-output.js'
import { registerLegacyClientTransport } from '../src/v2-rpc-client-transport.js'
import { registerConfirmedCommandOutput } from '../src/v2-command-output-receipts.js'
import { createRpcDeliveredNativeV2BridgeDefinition } from '../src/v2-rpc-native-bridge.js'
import { settleLegacyCleanup } from '../src/legacy-lifecycle.js'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const turn = () => new Promise(setImmediate)
const flatten = error => [error, ...(error?.errors ?? []).flatMap(flatten), ...(error?.cause ? flatten(error.cause) : [])]
const request = { sessionID: 's1', command: 'probe', parts: [{ type: 'text', text: 'harmless output' }] }
const logRequest = { body: { service: 'generic', level: 'info', message: 'harmless log' } }
function observe(promise) {
  const state = { status: 'pending' }
  promise.then(value => { state.status = 'fulfilled'; state.value = value }, error => { state.status = 'rejected'; state.error = error })
  return state
}
function host({ emit, dispose } = {}) {
  const entered = deferred(), records = []
  return { entered: entered.promise, records, ctx: { location: { directory: 'C:/isolated-cleanup-project' }, rpc: { async register(definition, methods) {
    const record = { definition, methods, disposeCalls: 0, closed: false, emits: 0 }; records.push(record)
    return { events: { emit(name, data) { record.emits++; entered.resolve(); return emit?.(name, data, methods) } },
      dispose() { record.disposeCalls++; const result = dispose?.(record); return Promise.resolve(result).then(() => { record.closed = true }) } }
  } } } }
}
async function settleAll(...promises) { await Promise.allSettled(promises.filter(Boolean)) }
test('publication-only emitter cannot hold cleanup open past its lifecycle deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise }), p = await registerRpcCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 })
  const operation = p.deliver(request); operation.catch(() => {})
  await h.entered
  const closing = p.dispose(), state = observe(closing)
  await turn(); t.mock.timers.tick(20); await turn()
  try {
    assert.equal(state.status, 'rejected', 'Nonsettling emitter cleanup must report a bounded failure')
    assert.equal(state.error.code, 'cleanup-timeout')
    assert.ok(state.error.operations.some(item => /publication/.test(item.operation) && item.state === 'pending'))
    assert.equal(h.records[0].disposeCalls, 0, 'Disposal must wait for actual publication settlement')
  } finally { gate.resolve(); await settleAll(operation, closing, closing.cleanupDone) }
})

test('supplied logger cannot hold client cleanup open past its lifecycle deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), entered = deferred(), h = host()
  const p = await registerLegacyClientTransport(h.ctx, { lifecycleTimeoutMs: 20, log: () => { entered.resolve(); return gate.promise } })
  const operation = p.client.app.log(logRequest); operation.catch(() => {}); await entered.promise
  const closing = p.dispose(), state = observe(closing)
  await turn(); t.mock.timers.tick(20); await turn()
  try {
    assert.equal(state.status, 'rejected', 'Nonsettling logger cleanup must report a bounded failure')
    assert.equal(state.error.code, 'cleanup-timeout')
    assert.ok(state.error.operations.some(item => /logger/.test(item.operation) && item.state === 'pending'))
    assert.equal(h.records[0].disposeCalls, 0)
  } finally { gate.resolve(); await settleAll(operation, closing, closing.cleanupDone) }
})

for (const mode of ['output', 'readiness']) test('confirmed ' + mode + ' cleanup cannot claim release while native publication is pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise })
  const p = await registerConfirmedCommandOutput(h.ctx, { lifecycleTimeoutMs: 20, receiptTimeoutMs: 1000 })
  const operation = mode === 'output' ? p.deliver(request) : p.assertReady(request); operation.catch(() => {})
  await h.entered
  const closing = p.dispose(), state = observe(closing)
  await turn(); t.mock.timers.tick(20); await turn()
  try {
    assert.equal(state.status, 'rejected', 'Caller cancellation is not native publication settlement')
    assert.equal(state.error.code, 'cleanup-timeout')
    assert.equal(h.records[0].disposeCalls, 0, 'RPC ownership remains unresolved until publication settles')
  } finally { gate.resolve(); await settleAll(operation, closing, closing.cleanupDone) }
})

test('in-flight logger rejection remains visible in cleanup instead of becoming success', async () => {
  const gate = deferred(), entered = deferred(), failure = Error('logger rejected'), h = host()
  const p = await registerLegacyClientTransport(h.ctx, { log: () => { entered.resolve(); return gate.promise } })
  const operation = p.client.app.log(logRequest), failedOperation = assert.rejects(operation, error => error === failure)
  await entered.promise
  const closing = p.dispose(); gate.reject(failure)
  await failedOperation
  await assert.rejects(closing, error => flatten(error).includes(failure))
  assert.equal(h.records[0].closed, true)
})

async function nativeFixture(t, { emit, log } = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'bounded-cleanup-'))
  t.after(async () => { assert.equal(dirname(directory), parent); await rm(directory, { recursive: true, force: true }) })
  const entry = join(directory, 'synthetic.mjs')
  await writeFile(entry, 'export const clients=[];export default async input=>{clients.push(input.client);return {"command.execute.before":async(input,output)=>{output.parts.push({type:"text",text:"output"})}}}')
  const h = host({ emit }); h.ctx.location = { directory }; const commands = []
  h.ctx.command = { async transform(callback) { const row = { entries: [], stops: 0 }; commands.push(row); callback({ add: item => row.entries.push(item) }); return { dispose() { row.stops++ } } } }
  const bridge = createRpcDeliveredNativeV2BridgeDefinition({ targets: [entry], commandNames: ['probe'], lifecycleTimeoutMs: 20, hostLog: log ?? (() => {}), bindings: {} })
  const close = await bridge.setup(h.ctx), module = await import(pathToFileURL(entry).href)
  return { ...h, commands, bridge, close, entry, client: module.clients[0] }
}

test('wrapper reports both unresolved emitter and logger and quarantines without waiting forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitter = deferred(), logger = deferred(), emitted = deferred(), logged = deferred()
  const h = await nativeFixture(t, { emit: () => { emitted.resolve(); return emitter.promise }, log: () => { logged.resolve(); return logger.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' }); command.catch(() => {})
  const logging = h.client.app.log(logRequest); logging.catch(() => {})
  await Promise.all([emitted.promise, logged.promise])
  const closing = h.close(), state = observe(closing)
  await turn(); t.mock.timers.tick(20); await turn()
  try {
    assert.equal(state.status, 'rejected', 'Wrapper cleanup must return a bounded error')
    assert.ok(flatten(state.error).some(error => error.code === 'cleanup-timeout'))
    assert.equal(h.commands[0].stops, 1, 'Independent native command removal must be attempted')
    await assert.rejects(h.bridge.setup(h.ctx), /quarantined/)
    assert.equal(h.records.length, 2)
  } finally { emitter.resolve(); logger.resolve(); await settleAll(command, logging, closing, closing.cleanupDone) }
})

for (const kind of ['emitter', 'logger']) for (const mode of ['synchronous', 'resolved']) test(kind + ' normal ' + mode + ' callback settles and closes its registration', async () => {
  let calls = 0
  const callback = () => { calls++; return mode === 'resolved' ? Promise.resolve('done') : undefined }
  const h = host({ emit: callback }), p = kind === 'emitter' ? await registerRpcCommandOutput(h.ctx) : await registerLegacyClientTransport(h.ctx, { log: callback })
  const operation = kind === 'emitter' ? p.deliver(request) : p.client.app.log(logRequest)
  await operation
  const closing = p.dispose(); assert.equal(closing, p.dispose()); await closing; await closing.cleanupDone
  assert.equal(calls, 1); assert.equal(h.records[0].disposeCalls, 1); assert.equal(h.records[0].closed, true)
})

for (const kind of ['emitter', 'logger']) for (const mode of ['throw', 'reject']) test(kind + ' ' + mode + ' remains attributable during cleanup', async () => {
  const failure = Error(kind + ' original failure')
  const callback = () => { if (mode === 'throw') throw failure; return Promise.reject(failure) }
  const h = host({ emit: callback }), p = kind === 'emitter' ? await registerRpcCommandOutput(h.ctx) : await registerLegacyClientTransport(h.ctx, { log: callback })
  const operation = kind === 'emitter' ? p.deliver(request) : p.client.app.log(logRequest)
  const rejected = assert.rejects(operation, error => error === failure), closing = p.dispose()
  await rejected
  await assert.rejects(closing, error => flatten(error).includes(failure) && error.operations.some(item => item.operation.includes(kind === 'logger' ? 'logger' : 'publication') && item.state === 'failed'))
  await assert.rejects(closing.cleanupDone, error => flatten(error).includes(failure))
  assert.equal(h.records[0].closed, true); assert.equal(h.records[0].disposeCalls, 1)
})

test('in-deadline emitter and logger drain permits normal wrapper reactivation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitGate = deferred(), logGate = deferred(), enteredEmit = deferred(), enteredLog = deferred()
  const h = await nativeFixture(t, { emit: () => { enteredEmit.resolve(); return emitGate.promise }, log: () => { enteredLog.resolve(); return logGate.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' })
  const failedCommand = assert.rejects(command, /disposed|delivery failed/), logging = h.client.app.log(logRequest)
  await Promise.all([enteredEmit.promise, enteredLog.promise])
  const closing = h.close(), state = observe(closing); await turn()
  t.mock.timers.tick(19); emitGate.resolve(); logGate.resolve()
  await Promise.all([failedCommand, logging, closing]); await closing.cleanupDone
  t.mock.timers.tick(1)
  assert.equal(state.status, 'fulfilled')
  const next = await h.bridge.setup(h.ctx); await next()
  assert.equal(h.records.length, 4); assert.ok(h.records.every(row => row.closed && row.disposeCalls === 1))
})

test('wrapper retains both simultaneous emitter and logger errors', async t => {
  const emitGate = deferred(), logGate = deferred(), emitted = deferred(), logged = deferred()
  const emitFailure = Error('emitter rejection'), logFailure = Error('logger rejection')
  const h = await nativeFixture(t, { emit: () => { emitted.resolve(); return emitGate.promise }, log: () => { logged.resolve(); return logGate.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' })
  const failedCommand = assert.rejects(command, /delivery failed/), logging = h.client.app.log(logRequest), failedLog = assert.rejects(logging, error => error === logFailure)
  await Promise.all([emitted.promise, logged.promise])
  const closing = h.close(); emitGate.reject(emitFailure); logGate.reject(logFailure)
  await Promise.all([failedCommand, failedLog])
  await assert.rejects(closing, error => flatten(error).includes(emitFailure) && flatten(error).includes(logFailure))
  await assert.rejects(closing.cleanupDone, error => flatten(error).includes(emitFailure) && flatten(error).includes(logFailure))
  assert.ok(h.records.every(row => row.closed)); assert.equal(h.commands[0].stops, 1)
  await assert.rejects(h.bridge.setup(h.ctx), /quarantined/)
})

test('timeout retains earlier independent errors and identifies a blocked registration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), failure = Error('independent cleanup failure'), calls = []
  const closing = settleLegacyCleanup([
    () => gate.promise,
    () => { calls.push('independent'); throw failure },
    () => { calls.push('registration') },
  ], { timeoutMs: 20, labels: ['emitter', 'independent cleanup', 'registration'], dependencies: [[], [], [0, 1]] })
  const state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); assert.equal(state.error.code, 'cleanup-timeout')
  assert.ok(state.error.errors.includes(failure))
  assert.deepEqual(calls, ['independent'])
  assert.equal(state.error.operations[2].state, 'not-attempted')
  assert.deepEqual(state.error.operations[2].dependencies, [0, 1])
  const snapshot = JSON.stringify(state.error.operations)
  gate.resolve(); await assert.rejects(closing.cleanupDone, error => flatten(error).includes(failure))
  assert.deepEqual(calls, ['independent', 'registration'])
  assert.equal(JSON.stringify(state.error.operations), snapshot)
  assert.ok(Object.isFrozen(state.error.operations) && Object.isFrozen(state.error.operations[2]))
})

test('late successful emitter settlement is diagnostic and cannot rewrite timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise }), p = await registerRpcCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 })
  const delivery = p.deliver(request); await h.entered
  const closing = p.dispose(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  const original = state.error, snapshot = JSON.stringify(original.operations)
  assert.equal(original.code, 'cleanup-timeout'); assert.equal(h.records[0].closed, false)
  assert.equal(p.dispose(), closing)
  await assert.rejects(p.deliver(request), /closed/)
  gate.resolve(); await delivery; await closing.cleanupDone
  await assert.rejects(p.dispose(), error => error === original)
  assert.equal(JSON.stringify(original.operations), snapshot)
  assert.equal(h.records[0].closed, true); assert.equal(h.records[0].disposeCalls, 1); assert.equal(h.records[0].emits, 1)
})

test('late logger rejection is preserved on cleanupDone without an unhandled rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), entered = deferred(), failure = Error('late logger failure'), unhandled = []
  const listener = error => unhandled.push(error); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener))
  const h = host(), p = await registerLegacyClientTransport(h.ctx, { lifecycleTimeoutMs: 20, log: () => { entered.resolve(); return gate.promise } })
  const operation = p.client.app.log(logRequest), failedOperation = assert.rejects(operation, error => error === failure)
  await entered.promise
  const closing = p.dispose(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  const original = state.error, snapshot = JSON.stringify(original.operations)
  gate.reject(failure); await failedOperation
  await assert.rejects(closing.cleanupDone, error => flatten(error).includes(failure))
  await turn()
  assert.deepEqual(unhandled, []); assert.equal(state.error, original)
  assert.equal(JSON.stringify(original.operations), snapshot); assert.equal(h.records[0].closed, true)
})

test('late wrapper settlement never clears quarantine or retries creation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), emitted = deferred()
  const h = await nativeFixture(t, { emit: () => { emitted.resolve(); return gate.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' }), failedCommand = assert.rejects(command, /disposed|delivery failed/)
  await emitted.promise
  const closing = h.close(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); const original = state.error
  assert.equal(h.close(), closing)
  await assert.rejects(h.bridge.setup(h.ctx), /quarantined/)
  gate.resolve(); await failedCommand; await closing.cleanupDone
  assert.ok(h.records.every(row => row.closed))
  await assert.rejects(h.close(), error => error === original)
  await assert.rejects(h.bridge.setup(h.ctx), /quarantined/)
  assert.equal(h.records.length, 2)
})

test('late cleanup from one definition cannot dispose an independent definition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), emitted = deferred()
  const h = await nativeFixture(t, { emit: () => { emitted.resolve(); return gate.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' }), failedCommand = assert.rejects(command, /disposed|delivery failed/)
  await emitted.promise
  const closing = h.close(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected')
  const second = createRpcDeliveredNativeV2BridgeDefinition({ id: 'independent-bridge', targets: [h.entry], commandNames: ['other-probe'], hostLog() {}, bindings: {}, lifecycleTimeoutMs: 20 })
  const closeSecond = await second.setup(h.ctx)
  assert.deepEqual(h.records.slice(2).map(record => record.closed), [false, false])
  gate.resolve(); await failedCommand; await closing.cleanupDone
  assert.deepEqual(h.records.slice(2).map(record => record.closed), [false, false])
  assert.deepEqual(h.records.slice(0, 2).map(record => record.closed), [true, true])
  await closeSecond(); assert.ok(h.records.every(row => row.closed && row.disposeCalls === 1))
})

test('registration disposer itself is bounded and attempted only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), entered = deferred(), h = host({ dispose: () => { entered.resolve(); return gate.promise } })
  const p = await registerRpcCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 }), closing = p.dispose(), state = observe(closing)
  await entered.promise; t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); assert.equal(h.records[0].disposeCalls, 1)
  assert.equal(state.error.operations[0].operation, 'command-output RPC registration disposal')
  assert.equal(state.error.operations[0].state, 'pending')
  assert.equal(p.dispose(), closing)
  gate.resolve(); await closing.cleanupDone; assert.equal(h.records[0].closed, true)
})

for (const kind of ['output', 'confirmed', 'client']) test(kind + ' invalid-registration rollback is bounded and retains actual completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), entered = deferred(); let attempts = 0, settled = false
  const ctx = { rpc: { async register() { return { events: {}, dispose() { attempts++; entered.resolve(); return gate.promise.then(() => { settled = true }) } } } } }
  const starting = kind === 'output' ? registerRpcCommandOutput(ctx, { lifecycleTimeoutMs: 20 })
    : kind === 'confirmed' ? registerConfirmedCommandOutput(ctx, { lifecycleTimeoutMs: 20 })
      : registerLegacyClientTransport(ctx, { log() {}, lifecycleTimeoutMs: 20 })
  const state = observe(starting); await entered.promise; t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); assert.equal(state.error.cleanupFailed, true)
  assert.ok(flatten(state.error).some(error => error.code === 'cleanup-timeout'))
  assert.equal(settled, false); assert.equal(attempts, 1)
  gate.resolve(); await state.error.cleanupDone
  assert.equal(settled, true); assert.equal(attempts, 1)
})

test('cleanup never assumes ownership of an externally supplied logger resource', async () => {
  let calls = 0, foreignDisposals = 0
  const log = () => { calls++; return false }; log.dispose = () => { foreignDisposals++; throw Error('must not dispose caller logger') }
  const h = host(), p = await registerLegacyClientTransport(h.ctx, { log })
  assert.equal(await p.client.app.log(logRequest), false)
  await p.dispose(); assert.equal(calls, 1); assert.equal(foreignDisposals, 0)
  assert.equal(h.records[0].closed, true)
})

test('previously handled operation failure does not poison later clean wrapper cleanup', async t => {
  const failure = Error('already handled logger error')
  const h = await nativeFixture(t, { log: () => { throw failure } })
  await assert.rejects(h.client.app.log(logRequest), error => error === failure)
  await h.close()
  const next = await h.bridge.setup(h.ctx); await next()
  assert.ok(h.records.every(row => row.closed))
})

test('nested timeout does not release a dependent registration before real settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), calls = []
  const inner = settleLegacyCleanup([() => gate.promise], { timeoutMs: 20, labels: ['native emitter'] })
  const outer = settleLegacyCleanup([() => inner, () => { calls.push('dispose') }], { timeoutMs: 20, labels: ['transport', 'registration'], dependencies: [[], [0]] })
  const state = observe(outer); await turn(); t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); assert.deepEqual(calls, [])
  gate.resolve(); await outer.cleanupDone
  assert.deepEqual(calls, ['dispose'])
  await assert.rejects(outer)
})

test('default cleanup budget remains the existing 2000 milliseconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise }), p = await registerRpcCommandOutput(h.ctx)
  const operation = p.deliver(request); await h.entered
  const closing = p.dispose(), state = observe(closing); await turn(); t.mock.timers.tick(1999); await turn()
  assert.equal(state.status, 'pending'); t.mock.timers.tick(1); await turn()
  assert.equal(state.error.code, 'cleanup-timeout')
  gate.resolve(); await operation; await closing.cleanupDone
})

test('completion not yet observable at the exact deadline retains timeout classification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise }), p = await registerRpcCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 })
  const operation = p.deliver(request); await h.entered
  const closing = p.dispose(), state = observe(closing); await turn()
  gate.resolve(); t.mock.timers.tick(20); await turn()
  assert.equal(state.status, 'rejected'); assert.equal(state.error.code, 'cleanup-timeout')
  await operation; await closing.cleanupDone
  assert.equal(h.records[0].closed, true)
})

test('output receipt timeout and subsequent cleanup timeout remain independent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise })
  const p = await registerConfirmedCommandOutput(h.ctx, { receiptTimeoutMs: 5, lifecycleTimeoutMs: 20 })
  const failed = assert.rejects(p.deliver(request), /receipt deadline/)
  await h.entered; t.mock.timers.tick(5); await failed
  const closing = p.dispose(), state = observe(closing); await turn(); t.mock.timers.tick(19); await turn()
  assert.equal(state.status, 'pending'); t.mock.timers.tick(1); await turn()
  assert.equal(state.error.code, 'cleanup-timeout')
  await assert.rejects(p.assertReady(request), /disposed/)
  assert.equal(h.records[0].emits, 1); assert.equal(h.records[0].disposeCalls, 0)
  gate.resolve(); await closing.cleanupDone; assert.equal(h.records[0].closed, true)
})

test('multiple client callbacks and registration errors all remain visible', async () => {
  const logGate = deferred(), toastGate = deferred(), logEntered = deferred(), toastEntered = deferred()
  const logFailure = Error('logger failure'), toastFailure = Error('toast failure'), registrationFailure = Error('registration failure')
  const h = host({ emit: () => { toastEntered.resolve(); return toastGate.promise }, dispose: () => { throw registrationFailure } })
  const p = await registerLegacyClientTransport(h.ctx, { log: () => { logEntered.resolve(); return logGate.promise } })
  const description = await h.records[0].methods.describe({ protocol: 1 })
  await h.records[0].methods.claim({ protocol: 1, activationID: description.activationID, consumerID: 'cleanup-consumer', location: description.location })
  const logging = p.client.app.log(logRequest), toast = p.client.tui.showToast({ body: { message: 'test' } })
  const failedLog = assert.rejects(logging, error => error === logFailure), failedToast = assert.rejects(toast, error => error.code === 'toast-disposed')
  await Promise.all([logEntered.promise, toastEntered.promise])
  const closing = p.dispose(); logGate.reject(logFailure); toastGate.reject(toastFailure)
  await Promise.all([failedLog, failedToast])
  await assert.rejects(closing, error => [logFailure, toastFailure, registrationFailure].every(failure => flatten(error).includes(failure)))
  await assert.rejects(closing.cleanupDone, error => flatten(error).includes(registrationFailure))
  assert.equal(h.records[0].disposeCalls, 1)
})

test('invalid cleanup attribution/dependency options reject before tasks execute', () => {
  let calls = 0
  for (const options of [{ labels: [] }, { labels: [1] }, { labels: Array(1) }, { dependencies: [[0]] }, { dependencies: [[1]] }, { dependencies: [[] , []] }, { dependencies: Array(1) }, { dependencies: [Array(1)] }]) {
    assert.throws(() => settleLegacyCleanup([() => { calls++ }], options), /Cleanup/)
  }
  assert.equal(calls, 0)
})

test('operation attribution does not copy command or log payload content', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), h = host({ emit: () => gate.promise }), p = await registerRpcCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 })
  const operation = p.deliver({ ...request, command: 'private-name', parts: [{ type: 'text', text: 'private-content' }] })
  await h.entered
  const closing = p.dispose(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  assert.equal(state.error.code, 'cleanup-timeout')
  assert.doesNotMatch(JSON.stringify(state.error.operations), /private-name|private-content/)
  gate.resolve(); await operation; await closing.cleanupDone
})

import { performance } from 'node:perf_hooks'
test('late completion cannot beat an overdue cleanup timer through microtask ordering', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now)
  const closing = settleLegacyCleanup([() => { now = 120 }], { timeoutMs: 20, labels: ['late native completion'] })
  await assert.rejects(closing, error => error.code === 'cleanup-timeout' && error.operations[0].settlement === 'completed')
  await closing.cleanupDone
})

test('late cleanup failure retains both deadline failure and original callback failure', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now)
  const failure = Error('late operation failure')
  const closing = settleLegacyCleanup([() => { now = 120; throw failure }], { timeoutMs: 20, labels: ['late failing callback'] })
  await assert.rejects(closing, error => error.code === 'cleanup-timeout' && error.errors.includes(failure))
  await assert.rejects(closing.cleanupDone, error => flatten(error).includes(failure))
})

test('wrapper timeout identifies nested emitter and logger work before child timers fire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitGate = deferred(), logGate = deferred(), emitted = deferred(), logged = deferred()
  const h = await nativeFixture(t, { emit: () => { emitted.resolve(); return emitGate.promise }, log: () => { logged.resolve(); return logGate.promise } })
  const command = h.commands[0].entries[0].execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'queue' }); command.catch(() => {})
  const logging = h.client.app.log(logRequest); logging.catch(() => {})
  await Promise.all([emitted.promise, logged.promise])
  const closing = h.close(), state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  const expand = rows => rows.flatMap(row => [row, ...expand(row.children ?? [])])
  try {
    const operations = expand(state.error.operations)
    assert.ok(operations.some(row => row.operation === 'command-output publication' && row.settlement === 'pending'))
    assert.ok(operations.some(row => row.operation === 'legacy logger callback' && row.settlement === 'pending'))
    assert.ok(operations.some(row => row.operation === 'legacy-client RPC registration disposal' && row.state === 'not-attempted'))
    const snapshot = JSON.stringify(state.error.operations)
    emitGate.resolve(); logGate.resolve(); await settleAll(command, logging, closing.cleanupDone)
    assert.equal(JSON.stringify(state.error.operations), snapshot)
  } finally { emitGate.resolve(); logGate.resolve(); await settleAll(command, logging, closing, closing.cleanupDone) }
})

for (const mode of ['output', 'readiness']) test('reentrant cleanup captures a ' + mode + ' publication before invoking the supplied emitter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(); let closing
  const h = host({ emit: () => { closing = p.dispose(); return gate.promise } })
  const p = await registerConfirmedCommandOutput(h.ctx, { lifecycleTimeoutMs: 20 })
  const operation = mode === 'output' ? p.deliver(request) : p.assertReady(request); operation.catch(() => {})
  await h.entered
  const state = observe(closing); await turn(); t.mock.timers.tick(20); await turn()
  try {
    assert.equal(state.status, 'rejected', 'A reentrant disposer must still own the native publication')
    assert.equal(state.error.code, 'cleanup-timeout')
    assert.equal(h.records[0].disposeCalls, 0)
  } finally { gate.resolve(); await settleAll(operation, closing, closing.cleanupDone) }
  assert.equal(h.records[0].disposeCalls, 1)
})
