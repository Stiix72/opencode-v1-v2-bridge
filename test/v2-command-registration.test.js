import test from 'node:test'
import assert from 'node:assert/strict'
import { registerV2LegacyCommands, registerPreparedV2LegacyCommands, V2CommandRegistrationError } from '../src/v2-command-registration.js'

function host() {
  const commands = []
  return { commands, domain: { async transform(callback) { callback({ add(definition) { commands.push(definition) } }); return { dispose() {} } } } }
}
const decode = (invocation, name) => ({ command: name, sessionID: invocation.sessionID, arguments: invocation.prompt })

test('registers command and delivers legacy parts without model call', async () => {
  const h = host(), delivered = []
  await registerV2LegacyCommands(h.domain, [{ name: 'mood', hook: async (input, output) => {
    assert.equal(input.arguments, 'happy')
    output.parts.push({ type: 'text', text: 'Mood updated' })
  } }], { decode, deliver: result => delivered.push(result) })
  await h.commands[0].execute({ sessionID: 's1', prompt: 'happy' })
  assert.deepEqual(delivered[0].parts, [{ type: 'text', text: 'Mood updated' }])
})

test('requires decoder and delivery before registering', async () => {
  const h = host()
  await assert.rejects(() => registerV2LegacyCommands(h.domain, [{ name: 'mood', hook() {} }], { decode }), /delivery/)
  assert.equal(h.commands.length, 0)
})

test('duplicate names fail before any registration', async () => {
  const h = host(), entry = { name: 'mood', hook() {} }
  await assert.rejects(() => registerV2LegacyCommands(h.domain, [entry, entry], { decode, deliver() {} }), /Duplicate/)
  assert.equal(h.commands.length, 0)
})

test('invalid second entry does not register first', async () => {
  const h = host()
  await assert.rejects(() => registerV2LegacyCommands(h.domain, [{ name: 'mood', hook() {} }, { name: 'bad name', hook() {} }], { decode, deliver() {} }), /Invalid/)
  assert.equal(h.commands.length, 0)
})

test('rejects decoded command identity mismatch before legacy side effects', async () => {
  const h = host(); let calls = 0
  await registerV2LegacyCommands(h.domain, [{ name: 'mood', hook() { calls++ } }], {
    decode: () => ({ command: 'personality', sessionID: 's1' }), deliver() {},
  })
  await assert.rejects(h.commands[0].execute({ sessionID: 's1' }), V2CommandRegistrationError)
  assert.equal(calls, 0)
})

test('rejects decoded session mismatch before legacy side effects', async () => {
  const h = host(); let calls = 0
  await registerV2LegacyCommands(h.domain, [{ name: 'mood', hook() { calls++ } }], {
    decode: () => ({ command: 'mood', sessionID: 'wrong' }), deliver() {},
  })
  await assert.rejects(h.commands[0].execute({ sessionID: 's1' }), /Session identity mismatch/)
  assert.equal(calls, 0)
})

test('delivery failure does not re-run state-changing hook', async () => {
  const h = host(); let calls = 0
  await registerV2LegacyCommands(h.domain, [{ name: 'mood', hook(_, output) {
    calls++; output.parts.push({ type: 'text', text: 'done' })
  } }], { decode, deliver() { throw new Error('not visible') } })
  await assert.rejects(h.commands[0].execute({ sessionID: 's1', prompt: '' }), /do not retry/)
  assert.equal(calls, 1)
})

test('preserves original invocation without mutating prompt', async () => {
  const h = host(); const invocation = { sessionID: 's1', prompt: 'edit --field name --value Foo' }
  let observed
  await registerV2LegacyCommands(h.domain, [{ name: 'personality', hook: input => { observed = input.arguments } }], { decode, deliver() {} })
  await h.commands[0].execute(invocation)
  assert.equal(observed, invocation.prompt)
  assert.equal(invocation.prompt, 'edit --field name --value Foo')
})

test('uses a single command transform for multiple definitions', async () => {
  let transforms = 0
  const registered = []
  const domain = { async transform(callback) {
    transforms++
    callback({ add: definition => registered.push(definition.name) })
    return { dispose() {} }
  } }
  const result = await registerV2LegacyCommands(domain, [
    { name: 'mood', hook() {} }, { name: 'personality', hook() {} },
  ], { decode, deliver() {} })
  assert.equal(transforms, 1)
  assert.deepEqual(registered, ['mood', 'personality'])
  assert.equal(typeof result.dispose, 'function')
})

test('command transform can replay registrations without running legacy hooks', async () => {
  let replay, calls = 0
  const domain = { async transform(callback) { replay = callback; return { dispose() {} } } }
  await registerV2LegacyCommands(domain, [{ name: 'mood', hook() { calls++ } }], { decode, deliver() {} })
  const names = []
  replay({ add: definition => names.push(definition.name) })
  replay({ add: definition => names.push(definition.name) })
  assert.deepEqual(names, ['mood', 'mood'])
  assert.equal(calls, 0)
})

test('rejects legacy command.add-only host without registering', async () => {
  let calls = 0
  await assert.rejects(registerV2LegacyCommands({ add() { calls++ } }, [
    { name: 'mood', hook() {} },
  ], { decode, deliver() {} }), /command.transform/)
  assert.equal(calls, 0)
})

test('rejects transform editor missing add without executing legacy hooks', async () => {
  let calls = 0
  await assert.rejects(registerV2LegacyCommands({ transform: async callback => callback({}) }, [
    { name: 'mood', hook() { calls++ } },
  ], { decode, deliver() {} }), /editor.add/)
  assert.equal(calls, 0)
})


test('rejects collision with native command before adding any legacy commands', async () => {
  const registered = []
  const domain = { transform: async callback => callback({
    list: () => [{ name: 'personality' }],
    add: definition => registered.push(definition.name),
  }) }
  await assert.rejects(registerV2LegacyCommands(domain, [
    { name: 'mood', hook() {} }, { name: 'personality', hook() {} },
  ], { decode, deliver() {} }), /already registered/)
  assert.deepEqual(registered, [])
})

test('rejects malformed command inventory before registering anything', async () => {
  const registered = []
  const domain = { transform: async callback => callback({
    list: () => [{ id: 'not-a-command-name' }],
    add: definition => registered.push(definition.name),
  }) }
  await assert.rejects(registerV2LegacyCommands(domain, [
    { name: 'mood', hook() {} },
  ], { decode, deliver() {} }), /invalid command definitions/)
  assert.deepEqual(registered, [])
})


test('command callback retains validated handler when caller mutates entry after registration', async () => {
  const h = host(), seen = []
  const entry = { name: 'mood', hook() { seen.push('original') } }
  await registerV2LegacyCommands(h.domain, [entry], { decode, deliver() {} })
  entry.hook = () => seen.push('replaced')
  entry.name = 'other'
  await h.commands[0].execute({ sessionID: 's1', prompt: '' })
  assert.deepEqual(seen, ['original'])
  assert.equal(h.commands[0].name, 'mood')
})

test('command callback retains validated handler when decoder mutates entry asynchronously', async () => {
  const h = host(), seen = []
  const entry = { name: 'mood', hook() { seen.push('original') } }
  await registerV2LegacyCommands(h.domain, [entry], {
    decode: async (invocation, name) => {
      entry.hook = () => seen.push('replaced')
      return { command: name, sessionID: invocation.sessionID }
    },
    deliver() {},
  })
  await h.commands[0].execute({ sessionID: 's1' })
  assert.deepEqual(seen, ['original'])
})


test('invalid command description reports a domain error before host registration', async () => {
  const h = host()
  await assert.rejects(
    registerV2LegacyCommands(h.domain, [{ name: 'mood', hook() {}, description: 42 }], { decode, deliver() {} }),
    error => error instanceof V2CommandRegistrationError && /Invalid description for mood/.test(error.message),
  )
  assert.deepEqual(h.commands, [])
})

test('audit: lower-level registration refuses invalid command names', async () => {
  let called = 0
  await assert.rejects(registerPreparedV2LegacyCommands({ transform: async () => { called++ } }, [
    { name: '', execute: async () => {} },
  ]), /Expected prepared command definitions/)
  assert.equal(called, 0)
})

test('command registration rejects sparse host command inventories before adding', async () => {
  const { registerPreparedV2LegacyCommands } = await import('../src/v2-command-registration.js')
  let added = 0
  const inventory = new Array(1)
  const domain = { transform: callback => callback({ list: () => inventory, add: () => added++ }) }
  await assert.rejects(registerPreparedV2LegacyCommands(domain, [{ name: 'mood', execute: async () => {} }]))
  assert.equal(added, 0)
})

test('command registration does not invoke host command identity getters', async () => {
  const { registerPreparedV2LegacyCommands } = await import('../src/v2-command-registration.js')
  let reads = 0, added = 0
  const existing = { get name() { reads++; return 'mood' } }
  const domain = { transform: callback => callback({ list: () => [existing], add: () => added++ }) }
  await assert.rejects(registerPreparedV2LegacyCommands(domain, [{ name: 'other', execute: async () => {} }]))
  assert.equal(reads, 0)
  assert.equal(added, 0)
})

test('command registration rejects mutable accessor-backed prepared handlers', async () => {
  const { registerPreparedV2LegacyCommands } = await import('../src/v2-command-registration.js')
  let reads = 0
  const entry = { name: 'mood', get execute() { reads++; return async () => {} } }
  await assert.rejects(registerPreparedV2LegacyCommands({ transform: () => {} }, [entry]))
  assert.equal(reads, 0)
})
