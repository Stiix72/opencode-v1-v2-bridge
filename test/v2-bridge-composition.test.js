import test from 'node:test'
import assert from 'node:assert/strict'
import { planV2LegacyBridge, activateV2LegacyBridge, V2BridgeCompositionError } from '../src/v2-bridge-composition.js'

const plugin = (hooks) => ({ id: 'fixture', hooks })

test('empty plan activates without registering', async () => {
  const plan = planV2LegacyBridge({}, [], {})
  const active = await activateV2LegacyBridge(plan)
  assert.equal(active.events.length, 0)
  await active.dispose()
})

test('preflight rejects unsupported hooks without side effects', () => {
  let calls = 0
  const ctx = { tool: { transform: () => calls++ } }
  assert.throws(() => planV2LegacyBridge(ctx, [plugin({ 'tool.definition': () => {} })]), /unimplemented hooks/)
  assert.equal(calls, 0)
})

test('preflight rejects missing command output delivery', () => {
  assert.throws(() => planV2LegacyBridge({ command: { transform() {} } }, [plugin({ 'command.execute.before': () => {} })], {
    commandEntries: () => [], decodeCommand: () => ({}),
  }), /deliverCommand/)
})

test('preflight rejects missing system mapping', () => {
  assert.throws(() => planV2LegacyBridge({ session: { hook() {} } }, [plugin({ 'experimental.chat.system.transform': () => {} })]), /mapSystemInput/)
})

test('preflight rejects missing event mapping', () => {
  assert.throws(() => planV2LegacyBridge({ event: { subscribe() {} } }, [plugin({ event: () => {} })]), /mapEvent/)
})

test('system prompt hook is registered and maps plugin provenance', async () => {
  let callback
  const p = plugin({ 'experimental.chat.system.transform': async (_input, output) => output.system.push('hello') })
  const ctx = { session: { hook: (name, fn) => { assert.equal(name, 'context'); callback = fn; return { dispose: async () => {} } } } }
  const active = await activateV2LegacyBridge(planV2LegacyBridge(ctx, [p], {
    mapSystemInput: async (event, from) => { assert.equal(from, p); return { sessionID: event.sessionID } },
  }))
  const event = { sessionID: 's', system: [{ type: 'text', text: 'initial' }] }
  await callback(event)
  assert.deepEqual(event.system.map(x => x.text), ['initial', 'hello'])
  assert.equal(active.system.length, 1)
  assert.equal(typeof active.system[0].dispose, 'function')
})

test('commands register only entries with the exact original handler', async () => {
  const original = async () => {}
  const added = []
  const ctx = { command: { transform: async callback => { callback({ add: entry => added.push(entry) }); return { dispose: async () => {} } } } }
  const p = plugin({ 'command.execute.before': original })
  const plan = planV2LegacyBridge(ctx, [p], {
    commandEntries: () => [{ name: 'mood', hook: original }],
    decodeCommand: () => ({}), deliverCommand: () => {},
  })
  const active = await activateV2LegacyBridge(plan)
  assert.equal(active.commands.length, 1)
  assert.equal(typeof active.commands[0].dispose, 'function')
  assert.equal(added[0].name, 'mood')
})

test('command hook mismatch fails before command.transform', async () => {
  let called = false
  const ctx = { command: { transform: () => { called = true } } }
  const p = plugin({ 'command.execute.before': async () => {} })
  const plan = planV2LegacyBridge(ctx, [p], {
    commandEntries: () => [{ name: 'mood', hook: async () => {} }],
    decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan), V2BridgeCompositionError)
  assert.equal(called, false)
})

test('host failure is reported with partial-registration warning', async () => {
  const ctx = { session: { hook: () => { throw Error('host broke') } } }
  const plan = planV2LegacyBridge(ctx, [plugin({ 'experimental.chat.system.transform': async () => {} })], {
    mapSystemInput: () => ({}),
  })
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|rollback both failed/)
})

test('event bridge starts after other registration and disposes', async () => {
  let subscribed = 0
  let closed = 0
  const ctx = { event: { subscribe: () => {
    subscribed++
    return { [Symbol.asyncIterator]() { return {
      next: () => Promise.resolve({ done: true }),
      return: async () => { closed++; return { done: true } },
    } } }
  } } }
  const plan = planV2LegacyBridge(ctx, [plugin({ event: async () => {} })], { mapEvent: () => null })
  const active = await activateV2LegacyBridge(plan)
  assert.equal(subscribed, 1)
  await active.dispose()
  assert.equal(closed, 1)
})

test('duplicate command names across plugins are rejected before any host mutation', async () => {
  let registered = 0
  const one = { id: 'one', hooks: { 'command.execute.before': async () => {} } }
  const two = { id: 'two', hooks: { 'command.execute.before': async () => {} } }
  const ctx = { command: { transform: () => registered++ }, tool: { transform: () => registered++ } }
  const plan = planV2LegacyBridge(ctx, [one, two], {
    commandEntries: p => [{ name: 'mood', hook: p.hooks['command.execute.before'] }],
    decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|rollback both failed/)
  assert.equal(registered, 0)
})

test('malformed command from later plugin does not register earlier commands', async () => {
  let registered = 0
  const one = { id: 'one', hooks: { 'command.execute.before': async () => {} } }
  const two = { id: 'two', hooks: { 'command.execute.before': async () => {} } }
  const plan = planV2LegacyBridge({ command: { transform: () => registered++ } }, [one, two], {
    commandEntries: p => [{ name: p.id === 'one' ? 'mood' : 'invalid command', hook: p.hooks['command.execute.before'] }],
    decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan))
  assert.equal(registered, 0)
})


test('preflight rejects malformed later event hook before any registration', () => {
  let registrations = 0
  const ctx = { tool: { transform: () => registrations++ }, event: { subscribe: () => registrations++ } }
  const plugins = [plugin({ tool: { valid: { execute: async () => {} } } }), plugin({ event: 'not a function' })]
  assert.throws(() => planV2LegacyBridge(ctx, plugins, {
    makeInvocation: () => ({}), mapEvent: () => null,
  }), /event must be a function/)
  assert.equal(registrations, 0)
})

test('preflight rejects malformed tool registry even with tool host available', () => {
  const ctx = { tool: { transform: () => { throw Error('must not register') } } }
  assert.throws(() => planV2LegacyBridge(ctx, [plugin({ tool: [] })], {
    makeInvocation: () => ({}),
  }), /tool registry must be an object/)
})

test('preflight rejects malformed system hook before registering tools', () => {
  let registrations = 0
  const ctx = { tool: { transform: () => registrations++ }, session: { hook: () => registrations++ } }
  assert.throws(() => planV2LegacyBridge(ctx, [plugin({
    tool: { valid: { execute: async () => {} } },
    'experimental.chat.system.transform': {},
  })], { makeInvocation: () => ({}), mapSystemInput: () => ({}) }), /must be a function/)
  assert.equal(registrations, 0)
})


test('mutation of validated hook after preflight is rejected before registration', async () => {
  let registrations = 0
  const p = plugin({ event: async () => {} })
  const plan = planV2LegacyBridge({ event: { subscribe: () => { registrations++ } } }, [p], { mapEvent: () => null })
  p.hooks.event = 'invalid now'
  await assert.rejects(activateV2LegacyBridge(plan), /changed after preflight/)
  assert.equal(registrations, 0)
})

test('mutation of nested tool execute after preflight is rejected', async () => {
  let registrations = 0
  const p = plugin({ tool: { example: { args: {}, execute: async () => {} } } })
  const plan = planV2LegacyBridge({ tool: { transform: () => { registrations++ } } }, [p], { makeInvocation: () => ({}) })
  p.hooks.tool.example.execute = null
  await assert.rejects(activateV2LegacyBridge(plan), /changed after preflight/)
  assert.equal(registrations, 0)
})

test('addition of unsupported hook after preflight is rejected', async () => {
  const p = plugin({})
  const plan = planV2LegacyBridge({}, [p])
  p.hooks['unimplemented.hook'] = () => {}
  await assert.rejects(activateV2LegacyBridge(plan), /changed after preflight/)
})

test('async commandEntries cannot replace a validated hook before host registration', async () => {
  let registrations = 0
  const original = async () => {}
  const p = plugin({ 'command.execute.before': original })
  const ctx = { command: { transform: () => { registrations++ } } }
  const plan = planV2LegacyBridge(ctx, [p], {
    commandEntries: async () => {
      await Promise.resolve()
      p.hooks['command.execute.before'] = async () => {}
      return [{ name: 'mood', hook: original }]
    },
    decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|rollback both failed/)
  assert.equal(registrations, 0)
})


test('tool host callback cannot mutate later event hook without detection', async () => {
  let subscriptions = 0
  const zodArgs = {
    _def: { typeName: 'ZodObject', unknownKeys: 'strip', catchall: { _def: { typeName: 'ZodNever' } }, shape: () => ({}) },
    parse: () => ({}),
  }
  const p = plugin({ tool: { ping: { args: zodArgs, execute: async () => 'pong' } }, event: async () => {} })
  const ctx = {
    tool: { list: async () => [], transform: () => { p.hooks.event = async () => {} } },
    event: { subscribe: () => { subscriptions++; throw Error('must not subscribe') } },
  }
  const plan = planV2LegacyBridge(ctx, [p], {
    makeInvocation: () => ({ sessionID: 's', messageID: 'm', agent: 'build', directory: '/work' }),
    mapEvent: () => null,
  })
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|rollback both failed/)
  assert.equal(subscriptions, 0)
})

test('system host callback cannot mutate a later event hook without detection', async () => {
  let subscriptions = 0
  const p = plugin({ 'experimental.chat.system.transform': async () => {}, event: async () => {} })
  const ctx = {
    session: { hook: () => { p.hooks.event = null } },
    event: { subscribe: () => { subscriptions++; throw Error('must not subscribe') } },
  }
  const plan = planV2LegacyBridge(ctx, [p], { mapSystemInput: () => ({}), mapEvent: () => null })
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|rollback both failed/)
  assert.equal(subscriptions, 0)
})

test('audit: a legacy command hook cannot silently register zero commands', async () => {
  let registered = 0
  const p = plugin({ 'command.execute.before': async () => {} })
  const plan = planV2LegacyBridge({ command: { transform: () => registered++ } }, [p], {
    commandEntries: () => [], decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan), /commandEntries|activation failed/i)
  assert.equal(registered, 0)
})

test('rejects sparse plugin arrays before registration', () => {
  const plugins = new Array(1)
  assert.throws(() => planV2LegacyBridge({}, plugins, {}), V2BridgeCompositionError)
})

test('rejects sparse command entries before registration', async () => {
  let registered = false
  const hook = async () => {}
  const p = plugin({ 'command.execute.before': hook })
  const ctx = { command: { transform: () => { registered = true } } }
  const plan = planV2LegacyBridge(ctx, [p], {
    commandEntries: () => new Array(1), decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan), V2BridgeCompositionError)
  assert.equal(registered, false)
})

test('preflight refuses sparse plugin list rather than silently omitting a target', () => {
  const plugins = new Array(1)
  assert.throws(() => planV2LegacyBridge({}, plugins, {}), /Invalid initialized plugin|sparse/i)
})

test('preflight does not invoke accessor-backed plugin hooks', () => {
  let calls = 0
  const p = { id: 'fixture', get hooks() { calls++; return {} } }
  assert.throws(() => planV2LegacyBridge({}, [p], {}), /accessor|invalid/i)
  assert.equal(calls, 0)
})

test('command staging rejects sparse entries before any host registration', async () => {
  let registrations = 0
  const hook = async () => {}
  const p = plugin({ 'command.execute.before': hook })
  const entries = new Array(2)
  entries[0] = { name: 'mood', hook }
  const plan = planV2LegacyBridge({ command: { transform: () => registrations++ } }, [p], {
    commandEntries: () => entries, decodeCommand: () => ({}), deliverCommand: () => {},
  })
  await assert.rejects(activateV2LegacyBridge(plan))
  assert.equal(registrations, 0)
})

test('preflight does not invoke accessor-backed individual hooks', () => {
  let calls = 0
  const hooks = {}
  Object.defineProperty(hooks, 'event', { enumerable: true, get() { calls++; return async () => {} } })
  assert.throws(() => planV2LegacyBridge({}, [plugin(hooks)], {}), /accessor|invalid/i)
  assert.equal(calls, 0)
})

test('preflight does not invoke accessor-backed tool definitions', () => {
  let calls = 0
  const tools = {}
  Object.defineProperty(tools, 'ping', { enumerable: true, get() { calls++; return { execute: async () => {} } } })
  assert.throws(() => planV2LegacyBridge({}, [plugin({ tool: tools })], {}), /accessor|invalid/i)
  assert.equal(calls, 0)
})

test('audit: last event subscription cannot mutate a preflighted hook unnoticed', async () => {
  const p = plugin({ event: async () => {} })
  const ctx = { event: { subscribe: () => {
    p.hooks.event = async () => {}
    return { [Symbol.asyncIterator]() { return { next: async () => ({done:true}), return: async () => ({done:true}) } } }
  } } }
  const plan = planV2LegacyBridge(ctx, [p], {mapEvent: () => null})
  await assert.rejects(activateV2LegacyBridge(plan), /activation failed|changed after preflight/)
})

test('audit: disposal waits for all subscriptions to settle despite an early rejection', async () => {
  const p1 = plugin({ event: async () => {} })
  const p2 = plugin({ event: async () => {} })
  let index = 0
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const ctx = {event: {subscribe: () => {
    const n = index++
    return { [Symbol.asyncIterator]() {return {
      next: async () => ({done:true}),
      return: async () => { if(n === 0) throw Error('cleanup failure'); await delayed; return {done:true} },
    }} }
  }}}
  const active = await activateV2LegacyBridge(planV2LegacyBridge(ctx, [p1,p2], {mapEvent: () => null}))
  let settled = false
  const closing = active.dispose().then(() => {settled = true}, () => {settled = true})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  await closing
})

test('audit 56: preflight does not invoke accessor-backed tool execute', () => {
  let calls = 0
  const definition = { get execute() { calls++; return async () => {} } }
  assert.throws(() => planV2LegacyBridge({}, [plugin({ tool: { ping: definition } })], {}), /accessor/i)
  assert.equal(calls, 0)
})

test('audit 56: activation does not invoke a newly installed hook getter', async () => {
  let calls = 0
  const p = plugin({ event: async () => {} })
  const plan = planV2LegacyBridge({ event: { subscribe() { throw Error('must not subscribe') } } }, [p], { mapEvent: () => null })
  Object.defineProperty(p.hooks, 'event', { configurable: true, get() { calls++; return async () => {} } })
  await assert.rejects(activateV2LegacyBridge(plan), /accessor|changed after preflight/i)
  assert.equal(calls, 0)
})

test('audit 56: activation does not invoke a newly installed execute getter', async () => {
  let calls = 0
  const definition = { execute: async () => {}, args: {} }
  const p = plugin({ tool: { ping: definition } })
  const plan = planV2LegacyBridge({ tool: { transform() { throw Error('must not register') } } }, [p], { makeInvocation: () => ({}) })
  Object.defineProperty(definition, 'execute', { configurable: true, get() { calls++; return async () => {} } })
  await assert.rejects(activateV2LegacyBridge(plan), /accessor|changed after preflight/i)
  assert.equal(calls, 0)
})

test('activation cleanup attempts every registration after synchronous disposal failure', async () => {
  const disposed = []
  const hook = async () => {}
  const ctx = {
    command: { transform: async callback => {
      callback({ add: () => {} })
      return { dispose: () => { disposed.push('command'); throw new Error('sync dispose failure') } }
    } },
    session: { hook: async () => ({ dispose: async () => { disposed.push('system') } }) },
  }
  const plan = planV2LegacyBridge(ctx, [plugin({
    'command.execute.before': hook,
    'experimental.chat.system.transform': async () => {},
  })], {
    commandEntries: () => [{ name: 'personality', hook }],
    decodeCommand: () => ({}), deliverCommand: () => {}, mapSystemInput: () => ({}),
  })
  const active = await activateV2LegacyBridge(plan)
  await assert.rejects(active.dispose(), error => error instanceof AggregateError &&
    error.errors.some(item => /sync dispose failure/.test(item.message)))
  assert.deepEqual(disposed, ['system', 'command'])
  await assert.rejects(active.dispose(), /cleanup failed/) // repeated cleanup preserves the original failure; no retry
})

test('failed activation rolls back remaining registrations despite synchronous dispose error', async () => {
  const disposed = []
  const hook = async () => {}
  const ctx = {
    command: { transform: async callback => {
      callback({ add: () => {} })
      return { dispose: () => { disposed.push('command'); throw new Error('cleanup failed') } }
    } },
    session: { hook: async () => { throw new Error('system registration failed') } },
  }
  const plan = planV2LegacyBridge(ctx, [plugin({
    'command.execute.before': hook,
    'experimental.chat.system.transform': async () => {},
  })], {
    commandEntries: () => [{ name: 'personality', hook }],
    decodeCommand: () => ({}), deliverCommand: () => {}, mapSystemInput: () => ({}),
  })
  await assert.rejects(activateV2LegacyBridge(plan), error => error instanceof V2BridgeCompositionError &&
    error.cause instanceof AggregateError && error.cause.errors.length === 2)
  assert.deepEqual(disposed, ['command'])
})
