import test from 'node:test'
import assert from 'node:assert/strict'
import { integrateLegacyTools, LegacyToolIntegrationError } from '../src/v2-tool-integration.js'

const args = () => ({
  _def: { typeName: 'ZodObject', unknownKeys: 'strip', catchall: { _def: { typeName: 'ZodNever' } }, shape: () => ({}) },
  parse: () => ({}),
})
const plugin = (id, schema = args()) => ({ id, hooks: { tool: { ping: { args: schema, execute: async () => 'pong' } } } })
const invocation = () => ({ sessionID: 's', messageID: 'm', agent: 'build', directory: '/work' })
function host(initial = []) {
  const calls = []
  const ctx = { tool: { list: async () => replay(), transform(fn) { calls.push(fn); return { dispose: async () => { const index=calls.indexOf(fn); if(index>=0)calls.splice(index,1) } } } } }
  const replay = (names = initial) => {
    const tools = [...names].map(id => ({ id }))
    const editor = { list: () => tools, add: info => tools.push({ id: info.name, ...info }) }
    for (const fn of calls) fn(editor)
    return tools
  }
  return { ctx, calls, replay }
}

test('composed pipeline registers and executes legacy tool on V2-shaped host', async () => {
  const h = host()
  const outcome = await integrateLegacyTools(h.ctx, [plugin('p')], { makeInvocation: invocation })
  assert.equal(outcome.registered, true)
  assert.equal(h.calls.length, 1)
  const [tool] = h.replay()
  assert.equal(tool.id, 'ping')
  assert.deepEqual(await tool.execute({}, {}), { content: 'pong' })
  assert.equal(h.replay().length, 1)
})

test('fail-closed preflight registers nothing when a plugin fails', async () => {
  const h = host()
  await assert.rejects(integrateLegacyTools(h.ctx, [plugin('good'), plugin('bad', { parse() {} })], { makeInvocation: invocation }), LegacyToolIntegrationError)
  assert.equal(h.calls.length, 0)
})

test('optional partial registration keeps valid plugins', async () => {
  const h = host()
  const result = await integrateLegacyTools(h.ctx, [plugin('good'), plugin('bad', { parse() {} })], { makeInvocation: invocation, allowPartial: true })
  assert.equal(result.snapshot.failures.length, 1)
  assert.equal(h.replay().length, 1)
})

test('native tool collisions fail before editor mutation', async () => {
  const h = host(['ping'])
  await assert.rejects(integrateLegacyTools(h.ctx, [plugin('p')], { makeInvocation: invocation }), /already registered/)
})

test('missing V2 registration capability fails clearly', async () => {
  await assert.rejects(integrateLegacyTools({}, [plugin('p')], { makeInvocation: invocation }), /tool.transform/)
})
