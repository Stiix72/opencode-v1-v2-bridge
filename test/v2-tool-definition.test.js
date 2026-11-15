import test from 'node:test'
import assert from 'node:assert/strict'
import { makeV2ToolDefinition, toV2ToolResult } from '../src/v2-tool-definition.js'
import { prepareV2Tools, registerV2ToolTransform } from '../src/v2-tool-registration.js'

test('maps descriptor to V2 Tool.Info name/input/description', async () => {
  const inputSchema = { type: 'object', properties: {} }
  const tool = makeV2ToolDefinition({ name: 'setMood', description: 'Mood', inputSchema, execute: async () => 'done' }, { makeInvocation: async () => ({}) })
  assert.equal(tool.name, 'setMood')
  assert.equal(tool.description, 'Mood')
  assert.equal(tool.input, inputSchema)
  assert.equal('id' in tool, false)
  assert.deepEqual(await tool.execute({}, { sessionID: 's' }), { content: 'done' })
})
test('does not run tool while preparing and replaying transforms', async () => {
  let count = 0
  const descriptor = { name: 'setMood', inputSchema: { type: 'object' }, execute: async () => { count++; return 'ok' } }
  const prepared = await prepareV2Tools({ tools: { setMood: descriptor } }, async d => makeV2ToolDefinition(d, { makeInvocation: async () => ({}) }))
  let callback
  await registerV2ToolTransform({ transform(fn) { callback = fn } }, prepared)
  const registered = []
  callback({ list: () => registered, add: item => registered.push(item) })
  assert.equal(count, 0)
  assert.equal(registered[0].name, 'setMood')
  assert.deepEqual(await registered[0].execute({}, {}), { content: 'ok' })
  assert.equal(count, 1)
})
test('preserves invocation identity and errors', async () => {
  const err = new Error('legacy failed')
  const context = { sessionID: 'session', messageID: 'message', agent: 'agent' }
  let captured
  const tool = makeV2ToolDefinition({ name: 'x', inputSchema: { type: 'object' }, execute: async (args, invocation) => { captured = { args, invocation }; throw err } }, { makeInvocation: async ctx => ({ ...ctx, directory: '/project' }) })
  await assert.rejects(tool.execute({ a: 1 }, context), e => e === err)
  assert.deepEqual(captured, { args: { a: 1 }, invocation: { ...context, directory: '/project' } })
})
test('accepts V1 output records while rejecting incomplete or absent results', () => {
  assert.deepEqual(toV2ToolResult(''), { content: '' })
  assert.deepEqual(toV2ToolResult({ output: 'x' }), { content: 'x' })
  assert.throws(() => toV2ToolResult({ title: 'x' }), /requires an output string/)
  assert.throws(() => toV2ToolResult(undefined), /requires a string or an output record/)
})
test('requires explicit invocation mapping and valid result', async () => {
  const d = { name: 'x', inputSchema: { type: 'object' }, execute: async () => 'ok' }
  assert.throws(() => makeV2ToolDefinition(d), /makeInvocation is required/)
  const tool = makeV2ToolDefinition(d, { makeInvocation: async () => ({}), convertResult: async () => ({}) })
  await assert.rejects(tool.execute({}, {}), /invalid V2 result/)
})

test('audit: execution uses validated descriptor callback despite later mutation', async () => {
  const descriptor = { name: 'safe', inputSchema: { type: 'object' }, execute: async () => 'original' }
  const tool = makeV2ToolDefinition(descriptor, { makeInvocation: async () => ({}) })
  descriptor.execute = async () => 'replaced'
  descriptor.name = 'other'
  assert.deepEqual(await tool.execute({}, {}), { content: 'original' })
})

test('audit: custom result converter cannot return malformed content', async () => {
  const descriptor = { name: 'safe', inputSchema: { type: 'object' }, execute: async () => 'ok' }
  for (const content of [undefined, null, 5, { text: 'ok' }]) {
    const tool = makeV2ToolDefinition(descriptor, {
      makeInvocation: async () => ({}), convertResult: async () => ({ content }),
    })
    await assert.rejects(tool.execute({}, {}), /invalid V2 result/)
  }
})
