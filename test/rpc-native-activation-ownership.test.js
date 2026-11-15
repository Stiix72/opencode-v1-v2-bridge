import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCommandOutputTuiCompanion } from '../src/v2-rpc-command-output.js'
import { createRpcDeliveredNativeV2BridgeDefinition } from '../src/v2-rpc-native-bridge.js'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flatten = error => [error, ...(error?.errors ?? []).flatMap(flatten), ...(error?.cause ? flatten(error.cause) : [])]
const invocation = (sessionID = 'session-a') => ({ sessionID, prompt: { text: 'read-only' }, delivery: 'queue' })
async function fixture(t, { factory, host = {}, options = {}, source } = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'rpc-activation-'))
  t.after(async () => { assert.equal(dirname(directory), parent); await rm(directory, { recursive: true, force: true }) })
  const entry = join(directory, 'legacy.mjs')
  await writeFile(entry, source ?? 'export default async input=>input.create()')
  const rpc = [], commands = [], calls = [], disposals = [], subscribers = new Map(), consumerErrors = []
  let factories = 0
  const ctx = {
    location: { directory },
    rpc: { async register(definition, methods) {
      const record = { definition, methods, index: rpc.length + 1, closed: false, emitted: [], disposals: 0 }
      rpc.push(record)
      await host.register?.(record)
      const invalid = host.invalid?.(record)
      if (invalid) return invalid
      return { events: { async emit(name, data) {
        assert.equal(record.closed, false, 'Cannot emit using disposed registration')
        record.emitted.push({ name, data })
        await host.emit?.(record, data)
        for (const fn of subscribers.get(definition.id + ':' + name) ?? []) Promise.resolve().then(()=>fn({data,location:ctx.location})).catch(error=>consumerErrors.push(error))
      } }, async dispose() {
        record.disposals++
        await host.rpcDispose?.(record)
        record.closed = true
      } }
    } },
    command: { async transform(callback) {
      const record = { entries: [], closed: false, disposals: 0 }
      callback({ add: entry => record.entries.push(entry) })
      commands.push(record)
      await host.commandRegister?.(record)
      return { async dispose() {
        record.disposals++
        await host.commandDispose?.(record)
        record.closed = true
      } }
    } },
  }
  const definition = createRpcDeliveredNativeV2BridgeDefinition({
    targets: [entry], commandNames: ['probe'], bindings: {},
    makeLegacyInput: () => ({ create: () => {
      const id = ++factories
      return factory ? factory(id) : {
        'command.execute.before': async (input, output) => { calls.push({ id, sessionID: input.sessionID }); output.parts.push({ type: 'text', text: 'activation-' + id + ':' + input.sessionID }) },
        dispose: async () => { disposals.push(id) },
      }
    } }),
    ...options,
  })
  const attachConsumer = options => createCommandOutputTuiCompanion({confirmedDelivery:true,...options}).setup({
    location:ctx.location,client:{rpc:d=>({
      ...Object.fromEntries(Object.keys(d.methods).map(name=>[name,async input=>{
        const current=rpc.findLast(row=>!row.closed&&row.definition.id===d.id)
        if(!current)throw Error('RPC unavailable')
        return current.methods[name](input)
      }])),
      events:{on(name,fn){const key=d.id+':'+name,set=subscribers.get(key)??new Set();set.add(fn);subscribers.set(key,set);return()=>set.delete(fn)}},
    })},ui:{toast:{show(){}}},
  })
  return { ctx, definition, rpc, commands, calls, disposals, directory, entry, attachConsumer, consumerErrors, get factories() { return factories } }
}
const execute = (h, index, sessionID) => h.commands[index].entries[0].execute(invocation(sessionID))

test('RPC wrapper first activation owns one command and output registration', async t => {
  const h = await fixture(t), close = await h.definition.setup(h.ctx)
  await execute(h, 0, 'first')
  assert.equal(h.rpc.length, 1); assert.equal(h.commands.length, 1)
  assert.deepEqual(h.rpc[0].emitted[0].data, { sessionID: 'first', command: 'probe', text: 'activation-1:first' })
  await close()
  assert.deepEqual(h.disposals, [1]); assert.ok(h.rpc[0].closed); assert.ok(h.commands[0].closed)
})

test('duplicate setup while active does not register a second bridge, even with a different context', async t => {
  const h = await fixture(t), close = await h.definition.setup(h.ctx)
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  await assert.rejects(h.definition.setup({ ...h.ctx }), /setup/)
  assert.equal(h.rpc.length, 1); assert.equal(h.factories, 1)
  await close()
})

test('concurrent setup is excluded while initial RPC registration is pending', async t => {
  const gate = deferred(), entered = deferred()
  const h = await fixture(t, { host: { register: async () => { entered.resolve(); await gate.promise } } })
  const starting = h.definition.setup(h.ctx); await entered.promise
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  assert.equal(h.rpc.length, 1)
  gate.resolve(); const close = await starting; await close()
})

test('completed cleanup permits fresh activation and stale cleanup cannot close it', async t => {
  const h = await fixture(t), first = await h.definition.setup(h.ctx)
  const closing = first(); assert.equal(first(), closing); await closing
  const second = await h.definition.setup(h.ctx)
  assert.notEqual(second, first); assert.equal(h.rpc.length, 2); assert.equal(h.factories, 2)
  assert.ok(h.rpc[0].closed); assert.equal(h.rpc[1].closed, false)
  await first(); assert.equal(h.rpc[1].closed, false)
  await assert.rejects(execute(h, 0, 'stale'), /disposed/)
  await execute(h, 1, 'second')
  assert.equal(h.rpc[0].emitted.length, 0)
  assert.equal(h.rpc[1].emitted[0].data.sessionID, 'second')
  assert.deepEqual(h.calls, [{ id: 2, sessionID: 'second' }])
  await second(); assert.deepEqual(h.disposals, [1, 2])
  assert.deepEqual(h.rpc.map(r => r.disposals), [1, 1])
})

test('reactivation is blocked until every independent cleanup completes', async t => {
  const gate = deferred(), entered = deferred()
  const h = await fixture(t, { host: { rpcDispose: async record => { if (record.index === 1) { entered.resolve(); await gate.promise } } } })
  const close = await h.definition.setup(h.ctx), closing = close(); await entered.promise
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  assert.equal(h.rpc.length, 1)
  gate.resolve(); await closing
  const next = await h.definition.setup(h.ctx); await next()
})

test('recoverable factory failure rolls back transports and permits fresh activation', async t => {
  const h = await fixture(t, { factory: id => { if (id === 1) throw Error('factory unavailable'); return {} } })
  await assert.rejects(h.definition.setup(h.ctx), /setup failed/)
  assert.ok(h.rpc[0].closed)
  const close = await h.definition.setup(h.ctx)
  assert.equal(h.factories, 2); assert.equal(h.rpc.length, 2)
  await close()
})

test('activation callback failure with successful rollback permits recovery', async t => {
  let count = 0
  const h = await fixture(t, { options: { onActivated() { if (++count === 1) throw Error('activation callback failed') } } })
  await assert.rejects(h.definition.setup(h.ctx), /setup failed/)
  assert.deepEqual(h.disposals, [1]); assert.ok(h.commands[0].closed); assert.ok(h.rpc[0].closed)
  const close = await h.definition.setup(h.ctx); await close()
  assert.deepEqual(h.disposals, [1, 2])
})

test('base activation can be disposed while setup awaits its activation callback', async t => {
  const entered = deferred(), gate = deferred(); let calls = 0
  const h = await fixture(t, { options: { onActivated: async active => {
    if (++calls === 1) { await active.dispose(); entered.resolve(); await gate.promise }
  } } })
  const failed = assert.rejects(h.definition.setup(h.ctx), /setup failed/)
  await entered.promise
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  gate.resolve(); await failed
  assert.ok(h.rpc[0].closed)
  const close = await h.definition.setup(h.ctx); await close()
})

test('failed first native RPC registration does not poison a later valid activation', async t => {
  const h = await fixture(t, { host: { register(record) { if (record.index === 1) throw Error('registration unavailable') } } })
  await assert.rejects(h.definition.setup(h.ctx), /registration unavailable/)
  const close = await h.definition.setup(h.ctx); await close()
  assert.equal(h.factories, 1)
})

test('client-registration rejection rolls back output before a valid subsequent activation', async t => {
  const h = await fixture(t, { host: { register(record) { if (record.index === 2) throw Error('client registration unavailable') } }, options: {
    hostLog() {}, makeLegacyInput: undefined,
  }, source: 'export default async()=>({})' })
  await assert.rejects(h.definition.setup(h.ctx), /client registration unavailable/)
  assert.ok(h.rpc[0].closed)
  const close = await h.definition.setup(h.ctx); await close()
  assert.equal(h.rpc.length, 4); assert.ok(h.rpc[2].closed); assert.ok(h.rpc[3].closed)
})

test('cleanup failure is aggregated, idempotent and quarantines activation', async t => {
  const nativeFailure = Error('native command cleanup failed'), rpcFailure = Error('RPC cleanup failed')
  const h = await fixture(t, { host: { commandDispose() { throw nativeFailure }, rpcDispose() { throw rpcFailure } } })
  const close = await h.definition.setup(h.ctx), closing = close()
  await assert.rejects(closing, error => flatten(error).includes(nativeFailure) && flatten(error).includes(rpcFailure))
  assert.equal(close(), closing); await assert.rejects(close())
  assert.deepEqual(h.disposals, [1]); assert.equal(h.rpc[0].disposals, 1); assert.equal(h.commands[0].disposals, 1)
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  await assert.rejects(h.definition.setup({ ...h.ctx }), /quarantined/)
  assert.equal(h.rpc.length, 1)
})

test('failed setup plus rollback failure cannot release activation ownership', async t => {
  const cleanupFailure = Error('rollback command removal failed')
  const h = await fixture(t, { host: { commandDispose() { throw cleanupFailure } }, options: {
    onActivated() { throw Error('setup callback failed') },
  } })
  await assert.rejects(h.definition.setup(h.ctx), error => flatten(error).includes(cleanupFailure))
  assert.ok(h.rpc[0].closed)
  await assert.rejects(h.definition.setup({ ...h.ctx }), /quarantined/)
  assert.equal(h.rpc.length, 1)
})

test('cleanup drains an in-flight command before reactivation and blocks its late output', async t => {
  const entered = deferred(), gate = deferred()
  const h = await fixture(t, { factory: id => ({
    'command.execute.before': async (input, output) => {
      if (id === 1) { entered.resolve(); await gate.promise }
      output.parts.push({ type: 'text', text: input.sessionID })
    },
  }) })
  const close = await h.definition.setup(h.ctx), rejected = assert.rejects(execute(h, 0, 'old-session'), /disposed/)
  await entered.promise
  const closing = close()
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  gate.resolve(); await rejected; await closing
  assert.equal(h.rpc[0].emitted.length, 0)
  const next = await h.definition.setup(h.ctx)
  await execute(h, 1, 'new-session')
  assert.equal(h.rpc[1].emitted[0].data.sessionID, 'new-session')
  await next()
})

test('confirmed transports and receipt handlers are fresh across activations', async t => {
  const h = await fixture(t, { options: { outputReceiptTimeoutMs: 1000 } })
  const first = await h.definition.setup(h.ctx), stopFirst = h.attachConsumer()
  await execute(h, 0, 'a'); const old = h.rpc[0].emitted.find(event=>event.name==='selectedOutput').data; stopFirst(); await first()
  const next = await h.definition.setup(h.ctx), stopNext = h.attachConsumer()
  assert.deepEqual(await h.rpc[0].methods.receipt({ deliveryID: old.deliveryID, selection: old.selection, status: 'displayed' }), { accepted: false })
  assert.deepEqual(await h.rpc[1].methods.receipt({ deliveryID: old.deliveryID, selection: old.selection, status: 'displayed' }), { accepted: false })
  await execute(h, 1, 'b')
  assert.notEqual(h.rpc[1].emitted.find(event=>event.name==='selectedOutput').data.deliveryID, old.deliveryID)
  assert.equal(h.rpc[1].emitted.find(event=>event.name==='selectedOutput').data.selection.sessionID, 'b')
  stopNext(); await next()
})

test('retained legacy client cannot log or toast into a later activation', async t => {
  const logs = []
  const h = await fixture(t, { options: { hostLog: value => { logs.push(value); return true }, makeLegacyInput: undefined },
    source: 'export const inputs=[]; export default async input=>{inputs.push(input);return {}}' })
  const module = await import(pathToFileURL(h.entry).href)
  const first = await h.definition.setup(h.ctx); const old = module.inputs[0].client
  await first()
  const next = await h.definition.setup(h.ctx), current = module.inputs[1].client
  await assert.rejects(old.app.log({ body: { level: 'info', message: 'stale' } }), /closed/)
  await assert.rejects(old.tui.showToast({ body: { message: 'stale' } }), /closed/)
  await current.app.log({ body: { level: 'info', message: 'current' } })
  assert.equal(logs.length, 1); assert.equal(logs[0].body.message, 'current')
  assert.deepEqual(h.rpc.map(r => r.closed), [true, true, false, false])
  await next()
})

for (const confirmed of [false, true]) test('malformed ' + (confirmed ? 'confirmed' : 'publication') + ' registration retains rollback failure and quarantine', async t => {
  const cleanupFailure = Error('invalid registration cleanup failed')
  const h = await fixture(t, { options: confirmed ? { outputReceiptTimeoutMs: 1000 } : {}, host: {
    invalid: () => ({ events: {}, dispose: async () => { throw cleanupFailure } }),
  } })
  await assert.rejects(h.definition.setup(h.ctx), error => flatten(error).includes(cleanupFailure))
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  assert.equal(h.rpc.length, 1)
})

test('missing output registration disposer leaves setup quarantined', async t => {
  const h = await fixture(t, { host: { invalid: () => ({ events: { emit() {} } }) } })
  await assert.rejects(h.definition.setup(h.ctx), /registration/)
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  assert.equal(h.rpc.length, 1)
})

test('invalid client registration cleanup failure quarantines wrapper after output rollback', async t => {
  const cleanupFailure = Error('client partial cleanup failed')
  const h = await fixture(t, { options: { hostLog() {}, makeLegacyInput: undefined }, source: 'export default async()=>({})',
    host: { invalid: record => record.index === 2 ? { dispose: async () => { throw cleanupFailure } } : undefined } })
  await assert.rejects(h.definition.setup(h.ctx), error => flatten(error).includes(cleanupFailure))
  assert.ok(h.rpc[0].closed)
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  assert.equal(h.rpc.length, 2)
})

test('malformed output registration with verified successful rollback permits recovery', async t => {
  let stops = 0
  const h = await fixture(t, { host: { invalid: record => record.index === 1 ? { dispose: async () => { stops++ } } : undefined } })
  await assert.rejects(h.definition.setup(h.ctx), /registration/)
  assert.equal(stops, 1)
  const close = await h.definition.setup(h.ctx); await close()
})

test('confirmed disposal cancels pending receipt before permitting a new activation', async t => {
  const emitted = deferred()
  const gate = deferred()
  const h = await fixture(t, { options: { outputReceiptTimeoutMs: 1000 } })
  const close = await h.definition.setup(h.ctx)
  const stop = h.attachConsumer({maxToastLength:1,onLongOutput:async()=>{emitted.resolve();await gate.promise}})
  const failed = assert.rejects(execute(h, 0, 'old'), /disposed|delivery failed/)
  await emitted.promise
  await close(); await failed; stop(); gate.resolve()
  await new Promise(setImmediate)
  assert.equal(h.consumerErrors.length, 1)
  assert.match(h.consumerErrors[0].message, /RPC unavailable/)
  const next = await h.definition.setup(h.ctx)
  const old = h.rpc[0].emitted.find(event=>event.name==='selectedOutput').data
  assert.deepEqual(await h.rpc[1].methods.receipt({ deliveryID: old.deliveryID, selection: old.selection, status: 'displayed' }), { accepted: false })
  await next()
})

test('a timed-out legacy cleanup stays quarantined even after its late settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred(), entered = deferred()
  const h = await fixture(t, { factory: () => ({ dispose: async () => { entered.resolve(); await gate.promise } }), options: { lifecycleTimeoutMs: 20 } })
  const close = await h.definition.setup(h.ctx), failure = assert.rejects(close(), /cleanup failed/)
  await entered.promise; t.mock.timers.tick(20); await failure
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  gate.resolve(); await Promise.resolve(); await Promise.resolve()
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
})

test('three activations never accumulate command or RPC registrations', async t => {
  const h = await fixture(t)
  for (let generation = 0; generation < 3; generation++) {
    const close = await h.definition.setup(h.ctx)
    assert.equal(h.rpc.filter(r => !r.closed).length, 1)
    assert.equal(h.commands.filter(r => !r.closed).length, 1)
    await execute(h, generation, 'session-' + generation)
    await close()
    assert.equal(h.rpc.filter(r => !r.closed).length, 0)
    assert.equal(h.commands.filter(r => !r.closed).length, 0)
  }
  assert.deepEqual(h.rpc.map(r => r.disposals), [1, 1, 1])
})

test('client registration failure plus failed output rollback prevents another activation', async t => {
  const registrationFailure = Error('client registration rejected'), cleanupFailure = Error('output rollback failed')
  const h = await fixture(t, { options: { hostLog() {}, makeLegacyInput: undefined }, source: 'export default async()=>({})', host: {
    register(record) { if (record.index === 2) throw registrationFailure },
    rpcDispose() { throw cleanupFailure },
  } })
  await assert.rejects(h.definition.setup(h.ctx), error => flatten(error).includes(registrationFailure) && flatten(error).includes(cleanupFailure))
  await assert.rejects(h.definition.setup(h.ctx), /quarantined/)
  assert.equal(h.rpc.length, 2); assert.equal(h.rpc[0].disposals, 1)
})

test('invalid client registration with confirmed successful rollback permits recovery', async t => {
  let stops = 0
  const h = await fixture(t, { options: { hostLog() {}, makeLegacyInput: undefined }, source: 'export default async()=>({})', host: {
    invalid: record => record.index === 2 ? { dispose: async () => { stops++ } } : undefined,
  } })
  await assert.rejects(h.definition.setup(h.ctx), /Invalid RPC registration/)
  assert.equal(stops, 1); assert.ok(h.rpc[0].closed)
  const close = await h.definition.setup(h.ctx); await close()
  assert.equal(h.rpc.length, 4)
})

test('publication already entered must settle before unconfirmed transport can be replaced', async t => {
  const gate = deferred(), entered = deferred()
  const h = await fixture(t, { host: { emit: async record => { if (record.index === 1) { entered.resolve(); await gate.promise } } } })
  const close = await h.definition.setup(h.ctx), command = assert.rejects(execute(h, 0, 'old'), error =>
    /output delivery failed; do not retry automatically/.test(error.message) && flatten(error).some(cause => cause.code === 'disposed'))
  await entered.promise
  const closing = close()
  await assert.rejects(h.definition.setup(h.ctx), /setup/)
  assert.equal(h.rpc[0].closed, false)
  gate.resolve(); await command; await closing
  const next = await h.definition.setup(h.ctx)
  await execute(h, 1, 'new')
  assert.equal(h.rpc[0].emitted.length, 1); assert.equal(h.rpc[1].emitted[0].data.sessionID, 'new')
  await next()
})
