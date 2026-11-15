import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareV2Tools, registerV2ToolTransform } from '../src/v2-tool-registration.js'

const snapshot = { tools: { setMood: { execute: async () => 'ok' }, savePersonality: { execute: async () => 'saved' } } }
const convert = async (d, name) => ({ id: name, execute: d.execute })
function domain(initial = []) {
  let transform
  const toolDomain = { async transform(fn) { transform = fn; return { dispose() {} } } }
  const replay = () => {
    const tools = [...initial]
    transform({ list: () => tools, add: (tool) => tools.push(tool) })
    return tools
  }
  return { toolDomain, replay }
}
test('prepare validates definitions before registration', async () => {
  const prepared = await prepareV2Tools(snapshot, convert)
  assert.deepEqual(prepared.map(t => t.name), ['setMood', 'savePersonality'])
  await assert.rejects(prepareV2Tools(snapshot, async () => ({})), /Invalid V2 definition/)
})
test('transform registers tools and remains replayable without executing them', async () => {
  let executed = 0
  const prepared = await prepareV2Tools({ tools: { a: { execute: async () => executed++ } } }, convert)
  const { toolDomain, replay } = domain()
  await registerV2ToolTransform(toolDomain, prepared)
  assert.deepEqual(replay().map(t => t.id), ['a'])
  assert.deepEqual(replay().map(t => t.id), ['a'])
  assert.equal(executed, 0)
})
test('native collisions reject entire replay without partial additions', async () => {
  const prepared = await prepareV2Tools(snapshot, convert)
  const { toolDomain, replay } = domain([{ id: 'savePersonality' }])
  await registerV2ToolTransform(toolDomain, prepared)
  assert.throws(replay, /already registered/)
})
test('bad host editor fails visibly', async () => {
  const prepared = await prepareV2Tools(snapshot, convert)
  let callback
  await registerV2ToolTransform({ transform: async fn => { callback = fn } }, prepared)
  assert.throws(() => callback({}), /missing list\/add/)
})
test('duplicate names rejected', async () => {
  const prepared = [{ name: 'a', definition: {} }, { name: 'a', definition: {} }]
  await assert.rejects(registerV2ToolTransform({ transform: async () => {} }, prepared), /duplicate/)
})

test('native tool with name but no id cannot be overwritten', async () => {
  const prepared = await prepareV2Tools(snapshot, convert)
  const { toolDomain, replay } = domain([{ name: 'setMood' }])
  await registerV2ToolTransform(toolDomain, prepared)
  assert.throws(replay, /already registered/)
})
test('malformed tool inventory fails before any additions', async () => {
  const prepared = await prepareV2Tools(snapshot, convert)
  let callback
  await registerV2ToolTransform({ transform: async fn => { callback = fn } }, prepared)
  let additions = 0
  assert.throws(() => callback({ list: () => [null], add: () => additions++ }), /invalid definitions/)
  assert.throws(() => callback({ list: () => null, add: () => additions++ }), /invalid definitions/)
  assert.equal(additions, 0)
})

test('registration captures prepared tool definitions against later mutation', async () => {
  const original = { id: 'safe', execute: async () => 'ok' }
  const prepared = [{ name: 'safe', definition: original }]
  const { toolDomain, replay } = domain()
  await registerV2ToolTransform(toolDomain, prepared)
  prepared[0].definition = { id: 'unexpected', execute: async () => 'wrong' }
  prepared.push({ name: 'unexpected', definition: { id: 'unexpected', execute: async () => 'wrong' } })
  assert.deepEqual(replay().map(tool => tool.id), ['safe'])
})

test('audit: mismatched registered tool identity cannot escape validation', async () => {
  const prepared = [{ name: 'approved', definition: { name: 'unapproved', execute: async () => {} } }]
  let called = 0
  await assert.rejects(registerV2ToolTransform({ transform: () => called++ }, prepared), /identity|mismatch/i)
  assert.equal(called, 0)
})

test('audit: conflicting id and name fields in one definition are rejected', async () => {
  const prepared = [{ name: 'approved', definition: { id: 'approved', name: 'unapproved', execute: async () => {} } }]
  let called = 0
  await assert.rejects(registerV2ToolTransform({ transform: () => called++ }, prepared), /identity|mismatch/i)
  assert.equal(called, 0)
})

test('audit: name resolver is evaluated once per prepared entry', async () => {
  let calls = 0
  const prepared = [{ name: 'approved', definition: { name: 'approved', execute: async () => {} } }]
  await registerV2ToolTransform({ transform: async () => {} }, prepared, {
    getName: () => (++calls === 1 ? 'approved' : 'unapproved'),
  })
  assert.equal(calls, 1)
})

test('audit: malformed prepared tool is rejected before invoking custom name resolver', async () => {
  let calls = 0
  await assert.rejects(registerV2ToolTransform({ transform: async () => {} }, [null], {
    getName: () => { calls++; return 'foo' },
  }), /Invalid prepared tool definition/)
  assert.equal(calls, 0)
})

test('audit: malformed host identity fields are rejected before additions', async () => {
  let callback
  await registerV2ToolTransform({ transform: async fn => { callback = fn } }, [
    { name: 'safe', definition: { name: 'safe', execute: async () => {} } },
  ])
  let additions = 0
  assert.throws(() => callback({ list: () => [{ id: 'native', name: 42 }], add: () => additions++ }), /invalid definitions/)
  assert.equal(additions, 0)
})
test('audit: non-JSON schema values are rejected before registration', async () => {
  let called=false
  await assert.rejects(registerV2ToolTransform({transform(){called=true}}, [{name:'sample',definition:{name:'sample',execute(){},input:{type:'object',properties:{x:{const:Infinity}}}}}]), /Non-JSON|non-finite/i)
  assert.equal(called,false)
})

test('audit: sparse JSON schema arrays cannot silently acquire null entries', async () => {
  const required = Array(2); required[1] = 'name'
  await assert.rejects(registerV2ToolTransform({transform() {}}, [{name:'x',definition:{name:'x',execute(){},input:{type:'object',required}}}]), /sparse|JSON|array/i)
})
test('audit: non-enumerable JSON schema constraints cannot silently disappear', async () => {
  const schema = {type:'object'}
  Object.defineProperty(schema, 'required', {value:['name'], enumerable:false})
  await assert.rejects(registerV2ToolTransform({transform() {}}, [{name:'x',definition:{name:'x',execute(){},input:schema}}]), /non-enumerable|JSON|property/i)
})
test('audit: symbol-keyed JSON schema constraints cannot silently disappear', async () => {
  const schema = {type:'object', [Symbol('hidden')]: true}
  await assert.rejects(registerV2ToolTransform({transform() {}}, [{name:'x',definition:{name:'x',execute(){},input:schema}}]), /symbol|JSON|property/i)
})

test('audit: schema accessors must not execute during snapshot', async () => {
  let calls = 0
  const schema = { type: 'object' }
  Object.defineProperty(schema, 'required', { enumerable: true, get() { calls++; return ['secret'] } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [
    { name: 'x', definition: { name: 'x', execute() {}, input: schema } },
  ]), /accessor|schema/i)
  assert.equal(calls, 0)
})

test('audit: schema array element accessors must not execute during snapshot', async () => {
  let calls = 0
  const required = ['x']
  Object.defineProperty(required, '0', { enumerable: true, get() { calls++; return 'x' } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [
    { name: 'x', definition: { name: 'x', execute() {}, input: { type: 'object', required } } },
  ]), /accessor|schema/i)
  assert.equal(calls, 0)
})

test('audit 52: sparse prepared tool lists must not silently omit entries', async () => {
  const prepared = Array(2)
  prepared[1] = { name: 'safe', definition: { name: 'safe', execute() {} } }
  let called = false
  await assert.rejects(registerV2ToolTransform({ transform() { called = true } }, prepared), /sparse|prepared|invalid/i)
  assert.equal(called, false)
})

test('audit 52: sparse host inventory must be rejected before additions', async () => {
  let callback
  await registerV2ToolTransform({ transform(fn) { callback = fn } }, [
    { name: 'safe', definition: { name: 'safe', execute() {} } },
  ])
  const inventory = Array(2)
  inventory[1] = { id: 'native' }
  let additions = 0
  assert.throws(() => callback({ list: () => inventory, add() { additions++ } }), /sparse|invalid|inventory/i)
  assert.equal(additions, 0)
})

test('audit 52: host inventory identity getters must not execute', async () => {
  let callback
  await registerV2ToolTransform({ transform(fn) { callback = fn } }, [
    { name: 'safe', definition: { name: 'safe', execute() {} } },
  ])
  let getterCalls = 0
  const native = {}
  Object.defineProperty(native, 'id', { enumerable: true, get() { getterCalls++; return 'native' } })
  assert.throws(() => callback({ list: () => [native], add() {} }), /accessor|invalid|identity/i)
  assert.equal(getterCalls, 0)
})

test('audit 52: prepared definition identity getters must not execute', async () => {
  let calls = 0
  const definition = { execute() {} }
  Object.defineProperty(definition, 'name', { enumerable: true, get() { calls++; return 'safe' } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [{ name: 'safe', definition }]), /accessor|identity/i)
  assert.equal(calls, 0)
})

test('audit 53: prepared tool metadata accessors are rejected without execution', async () => {
  let calls = 0
  const definition = { name: 'safe', execute() {} }
  Object.defineProperty(definition, 'description', { enumerable: true, get() { calls++; return 'surprise' } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [{ name: 'safe', definition }]), /accessor/i)
  assert.equal(calls, 0)
})

test('audit 53: prepared tool execute accessor is rejected without execution', async () => {
  let calls = 0
  const definition = { name: 'safe' }
  Object.defineProperty(definition, 'execute', { enumerable: true, get() { calls++; return () => {} } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [{ name: 'safe', definition }]), /accessor/i)
  assert.equal(calls, 0)
})

test('audit 53: prepared entry definition accessor is rejected without execution', async () => {
  let calls = 0
  const entry = { name: 'safe' }
  Object.defineProperty(entry, 'definition', { enumerable: true, get() { calls++; return { name: 'safe', execute() {} } } })
  await assert.rejects(registerV2ToolTransform({ transform() {} }, [entry]), /accessor/i)
  assert.equal(calls, 0)
})
