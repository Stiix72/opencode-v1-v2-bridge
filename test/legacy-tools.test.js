import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { translateLegacyTools, convertLegacySchema, LegacyToolConversionError } from '../src/legacy-tools.js'
const directory = resolve('/tmp/bridge-tool-workspace')
const invocation = { sessionID: 's1', messageID: 'm1', agent: 'build', directory }
const json = { type: 'object', properties: { mood: { type: 'string' } } }

test('JSON Schema tools translate without converter', async () => {
  const tools = await translateLegacyTools({ setMood: { description: 'Set mood', args: json, execute: async (args, ctx) => `${ctx.sessionID}:${args.mood}` } })
  assert.equal(tools.setMood.inputSchema, json)
  assert.equal(tools.setMood.description, 'Set mood')
  assert.equal(await tools.setMood.execute({ mood: 'happy' }, invocation), 's1:happy')
})
test('V1 callback gets original arguments and required context', async () => {
  const args = { mood: 'calm' }
  let observed
  const tools = await translateLegacyTools({ t: { args: json, execute: async (a, c) => { observed = { a, c }; return { title: 'ok', output: 'done' } } } })
  const result = await tools.t.execute(args, invocation)
  assert.equal(observed.a, args)
  assert.equal(observed.c.directory, directory)
  assert.deepEqual(result, { title: 'ok', output: 'done' })
})
test('unknown Zod-like schema requires converter', async () => {
  await assert.rejects(translateLegacyTools({ t: { args: { _def: {} }, execute() {} } }), /supply a verified converter/)
})
test('schema converter validates its output', async () => {
  await assert.rejects(convertLegacySchema({ _def: {} }, 't', async () => ({ nonsense: true })), /unsupported representation/)
})
test('schema converter errors retain original cause', async () => {
  const cause = new Error('zod version mismatch')
  await assert.rejects(convertLegacySchema({}, 't', async () => { throw cause }), err => err instanceof LegacyToolConversionError && err.cause === cause)
})
test('Standard Schema input passes through without conversion', async () => {
  const schema = { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } }
  assert.equal(await convertLegacySchema(schema, 't'), schema)
})
test('missing context identifiers fail before legacy callback executes', async () => {
  let called = false
  const tools = await translateLegacyTools({ t: { args: json, execute: () => { called = true } } })
  await assert.rejects(tools.t.execute({}, { directory }), /sessionID/)
  assert.equal(called, false)
})
test('host context mapper supports per-invocation workspaces', async () => {
  const tools = await translateLegacyTools({ t: { args: json, execute: async (_, ctx) => ctx.directory } }, {
    makeContext: invocation => ({ ...invocation, directory: resolve('/tmp/other-workspace') }),
  })
  assert.equal(await tools.t.execute({}, invocation), resolve('/tmp/other-workspace'))
})
test('tool names and schemas are validated', async () => {
  await assert.rejects(translateLegacyTools({ 'bad name': { args: json, execute() {} } }), /invalid tool name/)
  await assert.rejects(translateLegacyTools({ t: { execute() {} } }), /missing args schema/)
})
test('tool exceptions propagate without converting to successful results', async () => {
  const failure = new Error('tool failure')
  const tools = await translateLegacyTools({ t: { args: json, execute: async () => { throw failure } } })
  await assert.rejects(tools.t.execute({}, invocation), err => err === failure)
})
