import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLegacySystemPrompt, extractSystemText, registerLegacySystemPrompt, LegacySystemPromptError } from '../src/legacy-system-prompt.js'
const mapInput = event => ({ sessionID: event.sessionID })
const event = () => ({ sessionID: 's1', system: [{ type: 'text', text: 'base' }] })

test('appends legacy prompt while retaining existing text and array identity', async () => {
  const e = event()
  const originalArray = e.system
  await applyLegacySystemPrompt(async (input, output) => {
    assert.equal(input.sessionID, 's1')
    output.system.push('personality')
  }, e, { mapInput })
  assert.equal(e.system, originalArray)
  assert.deepEqual(e.system, [{ type: 'text', text: 'base' }, { type: 'text', text: 'personality' }])
})

test('supports legacy removal and replacement of text entries', async () => {
  const e = event()
  await applyLegacySystemPrompt(async (_, output) => { output.system = ['replacement'] }, e, { mapInput })
  assert.deepEqual(extractSystemText(e.system), ['replacement'])
})

test('refuses unsupported non-text parts without calling legacy side effects', async () => {
  const e = { system: [{ type: 'image', data: 'x' }] }
  let invoked = false
  await assert.rejects(applyLegacySystemPrompt(async () => { invoked = true }, e, { mapInput }), LegacySystemPromptError)
  assert.equal(invoked, false)
  assert.deepEqual(e.system, [{ type: 'image', data: 'x' }])
})

test('hook failure leaves original V2 system unchanged', async () => {
  const e = event()
  await assert.rejects(applyLegacySystemPrompt(async (_, out) => {
    out.system.push('partial')
    throw new Error('disk error')
  }, e, { mapInput }), /disk error/)
  assert.deepEqual(extractSystemText(e.system), ['base'])
})

test('invalid legacy output leaves original V2 system unchanged', async () => {
  const e = event()
  await assert.rejects(applyLegacySystemPrompt(async (_, out) => { out.system.push({ bad: true }) }, e, { mapInput }), LegacySystemPromptError)
  assert.deepEqual(extractSystemText(e.system), ['base'])
})

test('missing mapper fails before invoking legacy hook', async () => {
  let invoked = false
  await assert.rejects(applyLegacySystemPrompt(async () => { invoked = true }, event()), /mapper is required/)
  assert.equal(invoked, false)
})

test('registers context hook and invokes original handler when fired', async () => {
  let name, callback
  const registration = { dispose: async () => {} }
  const ctx = { session: { hook: async (n, cb) => { name = n; callback = cb; return registration } } }
  const result = await registerLegacySystemPrompt(ctx, async (_, out) => out.system.push('extra'), { mapInput })
  assert.equal(result, registration)
  assert.equal(name, 'context')
  const e = event()
  await callback(e)
  assert.deepEqual(extractSystemText(e.system), ['base', 'extra'])
})

test('missing host capability or input mapper prevents registration', async () => {
  await assert.rejects(registerLegacySystemPrompt({}, async () => {}, { mapInput }), /unavailable/)
  let registered = false
  await assert.rejects(registerLegacySystemPrompt({ session: { hook: () => { registered = true } } }, async () => {}), /mapper is required/)
  assert.equal(registered, false)
})


test('no-op legacy system hook preserves host text-part metadata and object identity', async () => {
  const first = { type: 'text', text: 'base', id: 'host-1', provenance: { source: 'host' } }
  const e = { sessionID: 's1', system: [first] }
  await applyLegacySystemPrompt(async () => {}, e, { mapInput })
  assert.equal(e.system[0], first)
  assert.equal(e.system[0].id, 'host-1')
})

test('appending a prompt retains metadata on unchanged existing system parts', async () => {
  const first = { type: 'text', text: 'base', metadata: { priority: 1 } }
  const e = { sessionID: 's1', system: [first] }
  await applyLegacySystemPrompt(async (_, output) => { output.system.push('legacy') }, e, { mapInput })
  assert.equal(e.system[0], first)
  assert.deepEqual(e.system[1], { type: 'text', text: 'legacy' })
})

test('prepending system text preserves metadata of shifted original entries', async () => {
  const first = { type: 'text', text: 'alpha', metadata: { owner: 'A' } }
  const second = { type: 'text', text: 'beta', metadata: { owner: 'B' } }
  const e = { sessionID: 's1', system: [first, second] }
  await applyLegacySystemPrompt(async (_, output) => { output.system.unshift('new') }, e, { mapInput })
  assert.deepEqual(e.system[0], { type: 'text', text: 'new' })
  assert.equal(e.system[1], first)
  assert.equal(e.system[2], second)
})

test('removing a system entry preserves metadata of shifted remaining entries', async () => {
  const first = { type: 'text', text: 'alpha', metadata: { owner: 'A' } }
  const second = { type: 'text', text: 'beta', metadata: { owner: 'B' } }
  const e = { sessionID: 's1', system: [first, second] }
  await applyLegacySystemPrompt(async (_, output) => { output.system.shift() }, e, { mapInput })
  assert.equal(e.system.length, 1)
  assert.equal(e.system[0], second)
})

test('alignment safety limit fails without modifying host system', async () => {
  const e = { sessionID: 's1', system: Array.from({ length: 1001 }, (_, i) => ({ type: 'text', text: `t${i}` })) }
  const original = e.system.slice()
  await assert.rejects(applyLegacySystemPrompt(async (_, output) => {
    output.system.push('new')
  }, e, { mapInput }), /safety limit/)
  assert.deepEqual(e.system, original)
})


test('async legacy hook cannot overwrite another hook’s appended system instruction', async () => {
  const e = event()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  const running = applyLegacySystemPrompt(async (_, output) => {
    started()
    await gate
    output.system.push('legacy')
  }, e, { mapInput })
  await ready
  e.system.push({ type: 'text', text: 'concurrent', owner: 'host' })
  release()
  await assert.rejects(running, /changed during legacy hook/)
  assert.deepEqual(extractSystemText(e.system), ['base', 'concurrent'])
})

test('async input mapper cannot overwrite replacement of host system array', async () => {
  const e = event()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  const running = applyLegacySystemPrompt(async (_, output) => {
    output.system.push('legacy')
  }, e, { mapInput: async value => { started(); await gate; return mapInput(value) } })
  await ready
  const replacement = [{ type: 'text', text: 'new host context' }]
  e.system = replacement
  release()
  await assert.rejects(running, /changed during legacy hook/)
  assert.equal(e.system, replacement)
})

test('malformed host system context fails with bridge error before mapper or legacy hook runs', async () => {
  for (const system of [undefined, null, {}, 'not-an-array']) {
    let invoked = false
    await assert.rejects(applyLegacySystemPrompt(async () => { invoked = true }, { sessionID: 's1', system }, {
      mapInput: () => { invoked = true; return { sessionID: 's1' } },
    }), LegacySystemPromptError)
    assert.equal(invoked, false)
  }
})

test('audit: sparse legacy output cannot introduce undefined system parts', async () => {
  const e = event()
  await assert.rejects(applyLegacySystemPrompt(async (_, out) => {
    out.system = Array(2)
    out.system[1] = 'new'
  }, e, { mapInput }), LegacySystemPromptError)
  assert.deepEqual(extractSystemText(e.system), ['base'])
})

test('audit: sparse host system input is rejected before running legacy hook', async () => {
  const e = event()
  e.system = Array(2)
  e.system[1] = { type: 'text', text: 'valid' }
  let called = false
  await assert.rejects(applyLegacySystemPrompt(async () => { called = true }, e, { mapInput }), LegacySystemPromptError)
  assert.equal(called, false)
})
