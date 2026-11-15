import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { registerConfirmedCommandOutput, confirmedOutputRpcDefinition as definition } from '../src/v2-command-output-receipts.js'
import { registerRpcCommandOutput, createCommandOutputTuiCompanion } from '../src/v2-rpc-command-output.js'
import { executeAndDeliverLegacyCommand } from '../src/legacy-command-bridge.js'
import { prepareV2LegacyCommands, registerV2LegacyCommands } from '../src/v2-command-registration.js'
import { createRpcDeliveredNativeV2BridgeDefinition } from '../src/v2-rpc-native-bridge.js'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const identity = (sessionID = 's1') => ({ command: 'probe', sessionID, arguments: '' })
const nativeInput = (sessionID = 's1') => ({ sessionID, prompt: { text: '' }, delivery: 'queue' })
const flatten = error => [error, ...(error?.errors ?? []).flatMap(flatten), ...(error?.cause ? flatten(error.cause) : [])]
function wire(directory = 'C:/isolated-readiness-project') {
  const registrations = [], listeners = new Map(), publications = [], errors = [], toasts = [], first = deferred(), commands = []
  const key = (d, name) => d.id + ':' + name
  const location = { directory }
  const ctx = { location, rpc: { async register(d, methods) {
    const row = { d, methods, closed: false, disposeCalls: 0 }; registrations.push(row)
    return { events: { async emit(name, data) {
      publications.push({ name, data, row }); first.resolve()
      await bus.beforePublish?.(name, data)
      // Publication is not consumer completion. Match the public host's split.
      for (const callback of [...(listeners.get(key(d, name)) ?? [])]) {
        const job = Promise.resolve().then(() => callback({ data, location }))
        job.catch(error => errors.push(error))
      }
    } }, async dispose() { row.disposeCalls++; await bus.onDispose?.(row); row.closed = true } }
  } }, command: { async transform(callback) { const record = { entries: [], closed: false }; callback({ add: item => record.entries.push(item) }); commands.push(record); return { async dispose() { record.closed = true } } } } }
  const rpc = d => ({ ...Object.fromEntries(Object.keys(d.methods).map(name => [name, async input => {
    const row = registrations.findLast(r => !r.closed && r.d.id === d.id)
    if (!row) throw Error('RPC unavailable')
    return row.methods[name](input)
  }])), events: { on(name, callback) {
    const k = key(d, name), set = listeners.get(k) ?? new Set(); set.add(callback); listeners.set(k, set)
    return () => set.delete(callback)
  } } })
  const consumerContext = { location, client: { rpc }, ui: { toast: { show: value => { toasts.push(value) } } } }
  const bus = { ctx, rpc, consumerContext, registrations, listeners, publications, errors, toasts, first: first.promise, commands }
  return bus
}
const hook = state => async (_input, output) => { state.effects++; output.parts.push({ type: 'text', text: 'output' }) }
async function absent(t, invoke) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), producer = await registerConfirmedCommandOutput(bus.ctx, { receiptTimeoutMs: 20 }), state = { effects: 0 }
  const rejected = assert.rejects(invoke(producer, hook(state)), /readiness|deadline|delivery failed/i)
  await bus.first; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0, 'Missing required consumer must prevent hook side effects')
  await producer.dispose()
}
test('direct execute-and-deliver prevents side effects with no confirmed consumer', t => absent(t, (producer, callback) =>
  executeAndDeliverLegacyCommand(callback, identity(), { deliver: producer.deliver })))

test('prepared native callback prevents side effects with no confirmed consumer', t => absent(t, (producer, callback) => {
  const [command] = prepareV2LegacyCommands([{ name: 'probe', hook: callback }], { decode: invocation => identity(invocation.sessionID), deliver: producer.deliver })
  return command.execute(nativeInput())
}))

test('RPC-composed native command rejects missing consumer before its synthetic hook', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'readiness-native-'))
  t.after(async () => { assert.equal(dirname(directory), parent); await rm(directory, { recursive: true, force: true }) })
  const entry = join(directory, 'synthetic.mjs'); await writeFile(entry, 'export default async input=>input.create()')
  const bus = wire(directory), state = { effects: 0 }
  const bridge = createRpcDeliveredNativeV2BridgeDefinition({ targets: [entry], commandNames: ['probe'], outputReceiptTimeoutMs: 20,
    makeLegacyInput: () => ({ create: () => ({ 'command.execute.before': hook(state) }) }), bindings: {} })
  const close = await bridge.setup(bus.ctx)
  const rejected = assert.rejects(bus.commands[0].entries[0].execute(nativeInput()), /readiness|deadline|delivery failed/i)
  await bus.first; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0, 'Native wrapper must enforce readiness before state changes')
  await close()
})

import { bindCommandOutputReadiness } from '../src/legacy-command-bridge.js'
const response = (data, overrides = {}) => ({ activationID: data.activationID, readinessID: data.readinessID, command: data.command, sessionID: data.sessionID, consumerID: 'synthetic-protocol-consumer', selectedOutput: true, state: 'ready', ...overrides })
async function producer(t, bus = wire(), deadline = 20) {
  const p = await registerConfirmedCommandOutput(bus.ctx, { receiptTimeoutMs: deadline })
  t.after(() => p.dispose())
  return p
}
function consume(t, bus, options) {
  const stop = createCommandOutputTuiCompanion({ confirmedDelivery: true, ...options }).setup(bus.consumerContext)
  t.after(stop)
  return stop
}
test('ready consumer permits prepared registration and real output acceptance', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  await registerV2LegacyCommands(bus.ctx.command, [{ name: 'probe', hook: hook(state) }], { decode: invocation => identity(invocation.sessionID), deliver: p.deliver })
  await bus.commands[0].entries[0].execute(nativeInput())
  assert.equal(state.effects, 1); assert.equal(bus.toasts[0].message, 'output')
  assert.deepEqual(bus.publications.map(p => p.name), ['readiness', 'selectedOutput'])
})

test('readiness alone neither displays output nor settles an output receipt', async t => {
  const bus = wire(), p = await producer(t, bus); consume(t, bus)
  const evidence = await p.assertReady(identity())
  assert.equal(evidence.state, 'ready'); assert.equal(bus.toasts.length, 0)
  assert.deepEqual(await bus.registrations[0].methods.receipt({ deliveryID: evidence.readinessID, status: 'displayed' }), { accepted: false })
  assert.deepEqual(bus.publications.map(p => p.name), ['readiness'])
})

test('known unavailable consumer explicitly rejects before hook execution', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  bus.consumerContext.ui.toast.show = () => { throw Error('must never display') }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), error =>
    /not executed/.test(error.message) && error.cause.code === 'readiness-unavailable')
  assert.equal(state.effects, 0); assert.equal(bus.publications.length, 1)
  assert.equal(bus.registrations[0].closed, false, 'A command refusal must not dispose a healthy producer')
})

test('consumer disappearing in the hook causes delivery failure without undoing effects or retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, stop = consume(t, bus), emitted = deferred()
  bus.beforePublish = name => { if (name === 'selectedOutput') emitted.resolve() }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(async (input, output) => {
    state.effects++; stop(); output.parts.push({ type: 'text', text: 'already executed' })
  }, identity(), { deliver: p.deliver }), /executed but output delivery failed; do not retry/)
  await emitted.promise; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 1)
  assert.equal(bus.publications.filter(p => p.name === 'selectedOutput').length, 1)
})

test('publication errors after readiness retain executed-command failure semantics', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, error = Error('native publication rejected')
  consume(t, bus); bus.beforePublish = name => { if (name === 'selectedOutput') throw error }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), failure =>
    /executed but output delivery failed/.test(failure.message) && failure.cause === error)
  assert.equal(state.effects, 1)
  assert.equal(bus.publications.filter(p => p.name === 'selectedOutput').length, 1)
})

for (const mismatch of ['sessionID', 'command', 'activationID']) test('readiness refuses mismatched ' + mismatch + ' before side effects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, replied = deferred()
  bus.beforePublish = async (name, data) => {
    if (name !== 'readiness') return
    assert.deepEqual(await bus.registrations[0].methods.readiness(response(data, { [mismatch]: 'wrong' })), { accepted: false })
    replied.resolve()
  }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await replied.promise; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0)
})

test('wrong native consumer location cannot establish readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }
  bus.consumerContext.location = { directory: 'C:/other-project' }; consume(t, bus)
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await bus.first; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0); assert.equal(bus.toasts.length, 0)
})

test('workspace activation fails before readiness because public HTTP RPC cannot route its receipt', async t => {
  const bus = wire(); bus.ctx.location = { ...bus.ctx.location, workspaceID: 'workspace-a' }
  const p = await producer(t, bus), state = { effects: 0 }
  bus.consumerContext.location = { directory: bus.ctx.location.directory, workspaceID: 'workspace-b' }; consume(t, bus)
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), error =>
    /not executed/.test(error.message) && /cannot route receipts by workspace/.test(error.cause.message))
  assert.equal(state.effects, 0)
  assert.equal(bus.publications.length, 0)
})

test('receipt-only old consumer cannot manufacture command readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }
  const oldRpc = bus.rpc(definition)
  const stop = oldRpc.events.on('output', event => oldRpc.receipt({ deliveryID: event.data.deliveryID, status: 'displayed' })); t.after(stop)
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await bus.first; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0); assert.deepEqual(bus.publications.map(p => p.name), ['readiness'])
})

test('missing native location is explicit unavailability, not invented ownership', async t => {
  const bus = wire(); delete bus.ctx.location
  const p = await producer(t, bus), state = { effects: 0 }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), error =>
    /not executed/.test(error.message) && error.cause.code === 'readiness-unavailable')
  assert.equal(state.effects, 0); assert.equal(bus.publications.length, 0)
})

test('cleanup before queued readiness publication prevents both probe and hook', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await p.dispose(); await rejected
  assert.equal(bus.publications.length, 0); assert.equal(state.effects, 0)
})

test('cleanup during pending readiness rejects and cannot be restored by a late response', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await bus.first; const data = bus.publications[0].data
  await p.dispose(); await rejected
  assert.deepEqual(await bus.registrations[0].methods.readiness(response(data)), { accepted: false })
  assert.equal(state.effects, 0)
})

test('consumer disconnection is rechecked on every command and legitimate reconnection restores readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, stop = consume(t, bus)
  await executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }); stop()
  const published = deferred(); bus.beforePublish = name => { if (name === 'readiness') published.resolve() }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await published.promise; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 1)
  consume(t, bus)
  await executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver })
  assert.equal(state.effects, 2)
})

test('old consumer and stale callbacks cannot make a new producer activation ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), a = await producer(t, bus), stopA = consume(t, bus)
  const prior = await a.assertReady(identity('old'))
  const oldCallback = [...bus.listeners.get(definition.id + ':readiness')][0]
  const oldProbe = bus.publications[0]
  await a.dispose()
  const b = await producer(t, bus), state = { effects: 0 }, published = deferred()
  bus.beforePublish = name => { if (name === 'readiness') published.resolve() }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity('new'), { deliver: b.deliver }), /not executed/)
  await published.promise
  await oldCallback({ data: oldProbe.data, location: bus.ctx.location })
  assert.deepEqual(await bus.registrations[1].methods.readiness(response(oldProbe.data)), { accepted: false })
  t.mock.timers.tick(20); await rejected; assert.equal(state.effects, 0)
  stopA(); consume(t, bus)
  const fresh = await b.assertReady(identity('new')); assert.notEqual(fresh.activationID, prior.activationID)
  await executeAndDeliverLegacyCommand(hook(state), identity('new'), { deliver: b.deliver })
  assert.equal(state.effects, 1)
  assert.equal([...bus.listeners.values()].reduce((sum, set) => sum + set.size, 0), 4)
})

test('concurrent session readiness probes do not share correlation or output receipts', async t => {
  const bus = wire(), p = await producer(t, bus); consume(t, bus)
  const [a, b] = await Promise.all([p.assertReady(identity('a')), p.assertReady(identity('b'))])
  assert.equal(a.sessionID, 'a'); assert.equal(b.sessionID, 'b')
  assert.notEqual(a.readinessID, b.readinessID); assert.equal(a.activationID, b.activationID)
  assert.equal(bus.toasts.length, 0)
})

test('a duplicate readiness response is refused without settling any output receipt', async t => {
  const bus = wire(), p = await producer(t, bus), acknowledgments = []
  bus.beforePublish = async (name, data) => {
    if (name !== 'readiness') return
    acknowledgments.push(await bus.registrations[0].methods.readiness(response(data)))
    acknowledgments.push(await bus.registrations[0].methods.readiness(response(data)))
  }
  const evidence = await p.assertReady(identity())
  assert.deepEqual(acknowledgments, [{ accepted: true }, { accepted: false }])
  assert.deepEqual(await bus.registrations[0].methods.receipt({ deliveryID: evidence.readinessID, status: 'displayed' }), { accepted: false })
})

test('overdue readiness response is refused before the timeout callback runs', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now)
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, replied = deferred()
  bus.beforePublish = async (name, data) => {
    now = 120
    assert.deepEqual(await bus.registrations[0].methods.readiness(response(data)), { accepted: false })
    replied.resolve()
  }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await replied.promise; await rejected; assert.equal(state.effects, 0)
})

test('late readiness publication completion cannot permit the hook', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now)
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }
  bus.beforePublish = async (name, data) => {
    assert.deepEqual(await bus.registrations[0].methods.readiness(response(data)), { accepted: true })
    now = 120
  }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  assert.equal(state.effects, 0)
})

test('hung readiness publication fails by deadline even after correlated reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, entered = deferred(), gate = deferred()
  bus.beforePublish = async (name, data) => {
    await bus.registrations[0].methods.readiness(response(data)); entered.resolve(); await gate.promise
  }
  const rejected = assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  await entered.promise; t.mock.timers.tick(20); await rejected
  assert.equal(state.effects, 0); gate.resolve()
})

test('gate passing does not extend an overdue output receipt or undo its command effects', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now)
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  bus.beforePublish = name => { if (name === 'selectedOutput') now += 20 }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /executed but output delivery failed/)
  assert.equal(state.effects, 1)
  assert.deepEqual(bus.publications.map(p => p.name), ['readiness', 'selectedOutput'])
})

test('session identity mutation during readiness is rejected before hook invocation', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }, input = identity()
  consume(t, bus); bus.beforePublish = name => { if (name === 'readiness') input.sessionID = 'changed' }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), input, { deliver: p.deliver }), error =>
    /not executed/.test(error.message) && /identity changed/.test(error.cause.message))
  assert.equal(state.effects, 0)
})

test('location ownership mutation while checking is rejected before hook execution', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  bus.beforePublish = async (name, data) => {
    await bus.registrations[0].methods.readiness(response(data))
    bus.ctx.location = { directory: 'C:/changed-owner' }
  }
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver }), /not executed/)
  assert.equal(state.effects, 0)
})

test('unconfirmed publication-only commands retain their existing contract without a consumer', async t => {
  const bus = wire(), p = await registerRpcCommandOutput(bus.ctx), state = { effects: 0 }; t.after(() => p.dispose())
  await executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: p.deliver })
  assert.equal(state.effects, 1); assert.deepEqual(bus.publications.map(p => p.name), ['output'])
})

test('unrelated explicit delivery callbacks do not acquire an implicit readiness requirement', async () => {
  const state = { effects: 0 }, outputs = []
  await executeAndDeliverLegacyCommand(hook(state), identity(), { deliver: async output => { outputs.push(output) } })
  assert.equal(state.effects, 1); assert.equal(outputs.length, 1)
})

test('a boolean readiness callback cannot manufacture successful readiness', async () => {
  const state = { effects: 0 }, deliver = async () => { throw Error('must not deliver') }
  bindCommandOutputReadiness(deliver, async () => true)
  assert.throws(() => bindCommandOutputReadiness(deliver, async () => ({ state: 'ready' })), /cannot be replaced/)
  await assert.rejects(executeAndDeliverLegacyCommand(hook(state), identity(), { deliver }), /not executed/)
  assert.equal(state.effects, 0)
})

async function nativeFixture(t, options = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'ready-native-'))
  t.after(async () => { assert.equal(dirname(directory), parent); await rm(directory, { recursive: true, force: true }) })
  const entry = join(directory, 'synthetic.mjs'); await writeFile(entry, 'export default async input=>input.create()')
  const bus = wire(directory), state = { effects: 0 }
  const bridge = createRpcDeliveredNativeV2BridgeDefinition({
    targets: [entry], commandNames: ['probe'], outputReceiptTimeoutMs: 20,
    makeLegacyInput: () => ({ create: () => ({ 'command.execute.before': hook(state) }) }), bindings: {},
    ...options,
  })
  return { bus, state, bridge }
}
test('native RPC wrapper reaches the real companion before hook and confirmed output', async t => {
  const h = await nativeFixture(t), close = await h.bridge.setup(h.bus.ctx); t.after(close)
  consume(t, h.bus)
  await h.bus.commands[0].entries[0].execute(nativeInput())
  assert.equal(h.state.effects, 1)
  assert.deepEqual(h.bus.publications.map(p => p.name), ['readiness', 'selectedOutput'])
  assert.equal(h.bus.toasts.length, 1)
})

test('native setup still starting cannot report command readiness through onActivated', async t => {
  let h, refusals = 0
  h = await nativeFixture(t, { onActivated: async () => {
    await assert.rejects(h.bus.commands[0].entries[0].execute(nativeInput()), /not executed/)
    refusals++
  } })
  consume(t, h.bus)
  const close = await h.bridge.setup(h.bus.ctx); t.after(close)
  assert.equal(refusals, 1); assert.equal(h.state.effects, 0); assert.equal(h.bus.publications.length, 0)
  await h.bus.commands[0].entries[0].execute(nativeInput()); assert.equal(h.state.effects, 1)
})

test('concurrent native setup cannot create duplicate readiness resources', async t => {
  const h = await nativeFixture(t), entered = deferred(), gate = deferred(), register = h.bus.ctx.rpc.register
  h.bus.ctx.rpc.register = async (...args) => { entered.resolve(); await gate.promise; return register(...args) }
  const starting = h.bridge.setup(h.bus.ctx); await entered.promise
  await assert.rejects(h.bridge.setup(h.bus.ctx), /setup/)
  assert.equal(h.bus.publications.length, 0); assert.equal(h.state.effects, 0)
  gate.resolve(); const close = await starting; t.after(close)
  consume(t, h.bus)
  await h.bus.commands[0].entries[0].execute(nativeInput())
  assert.equal(h.bus.registrations.length, 1)
  assert.equal(h.bus.publications.filter(p => p.name === 'readiness').length, 1)
})

test('native reactivation requires a new consumer association and rejects stale commands', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await nativeFixture(t), first = await h.bridge.setup(h.bus.ctx), stopFirst = consume(t, h.bus)
  await h.bus.commands[0].entries[0].execute(nativeInput('a'))
  const oldActivation = h.bus.publications[0].data.activationID
  await first()
  const second = await h.bridge.setup(h.bus.ctx); t.after(second)
  await assert.rejects(h.bus.commands[0].entries[0].execute(nativeInput('stale')), /disposed/)
  const emitted = deferred()
  h.bus.beforePublish = name => { if (name === 'readiness') emitted.resolve() }
  const rejected = assert.rejects(h.bus.commands[1].entries[0].execute(nativeInput('b')), /not executed/)
  await emitted.promise; t.mock.timers.tick(20); await rejected
  assert.equal(h.state.effects, 1)
  stopFirst(); consume(t, h.bus)
  await h.bus.commands[1].entries[0].execute(nativeInput('b'))
  assert.equal(h.state.effects, 2)
  const current = h.bus.publications.findLast(p => p.name === 'readiness').data.activationID
  assert.notEqual(current, oldActivation)
  assert.equal(h.bus.toasts.length, 2)
})

test('quarantined native activation cannot execute or restore readiness through a stale response', async t => {
  const h = await nativeFixture(t), close = await h.bridge.setup(h.bus.ctx); consume(t, h.bus)
  await h.bus.commands[0].entries[0].execute(nativeInput())
  const prior = h.bus.publications[0].data, cleanupFailure = Error('RPC removal failed')
  h.bus.onDispose = () => { throw cleanupFailure }
  await assert.rejects(close(), error => flatten(error).includes(cleanupFailure))
  await assert.rejects(h.bridge.setup(h.bus.ctx), /quarantined/)
  await assert.rejects(h.bus.commands[0].entries[0].execute(nativeInput()), /disposed/)
  assert.deepEqual(await h.bus.registrations[0].methods.readiness(response(prior)), { accepted: false })
  assert.equal(h.state.effects, 1)
})

test('native invocation decoder session mismatch is rejected before any readiness probe', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  const [command] = prepareV2LegacyCommands([{ name: 'probe', hook: hook(state) }], { decode: () => identity('wrong-session'), deliver: p.deliver })
  await assert.rejects(command.execute(nativeInput('real-session')), /Session identity mismatch/)
  assert.equal(state.effects, 0); assert.equal(bus.publications.length, 0)
})

test('a hook cannot retarget confirmed output to a session that did not pass readiness', async t => {
  const bus = wire(), p = await producer(t, bus), state = { effects: 0 }; consume(t, bus)
  await assert.rejects(executeAndDeliverLegacyCommand(async (input, output) => {
    state.effects++; input.sessionID = 'different-session'; output.parts.push({ type: 'text', text: 'changed identity' })
  }, identity(), { deliver: p.deliver }), error =>
    /executed but output delivery failed/.test(error.message) && /identity changed/.test(error.cause.message))
  assert.equal(state.effects, 1, 'Already executed side effects must not be described as rolled back')
  assert.deepEqual(bus.publications.map(p => p.name), ['readiness'])
})
