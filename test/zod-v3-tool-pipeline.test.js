import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareZodV3LegacyTools, convertZodV3ToolSchema, LegacyZodValidationError } from '../src/zod-v3-tool-pipeline.js'

const string = { _def: { typeName: 'ZodString', checks: [] } }
function schema() {
  return {
    _def: { typeName: 'ZodObject', unknownKeys: 'strip', catchall: { _def: { typeName: 'ZodNever' } }, shape: () => ({ mood: string }) },
    parse(input) {
      if (typeof input?.mood !== 'string') throw new Error('mood required')
      return { mood: input.mood }
    },
  }
}
const invocation = { sessionID: 's1', messageID: 'm1', agent: 'build', directory: '/workspace' }
const makeInvocation = () => invocation
const plugin = (id, args, execute) => ({ id, hooks: { tool: { setMood: { args, execute } } } })

test('converts and prepares Zod v3 tool with original runtime parser', async () => {
  let observed
  const result = await prepareZodV3LegacyTools([plugin('p', schema(), async (args, ctx) => {
    observed = { args, ctx }
    return 'done'
  })], { makeInvocation })
  assert.equal(result.snapshot.failures.length, 0)
  assert.equal(result.prepared.length, 1)
  assert.deepEqual(result.prepared[0].definition.input, { type: 'object', properties: { mood: { type: 'string' } }, additionalProperties: false, required: ['mood'] })
  assert.deepEqual(await result.prepared[0].definition.execute({ mood: 'calm', unexpected: true }, {}), { content: 'done' })
  assert.deepEqual(observed.args, { mood: 'calm' })
  assert.equal(observed.ctx.sessionID, 's1')
})
test('invalid arguments do not invoke the legacy tool', async () => {
  let called = false
  const { prepared } = await prepareZodV3LegacyTools([plugin('p', schema(), () => { called = true })], { makeInvocation })
  await assert.rejects(prepared[0].definition.execute({ mood: 3 }, {}), LegacyZodValidationError)
  assert.equal(called, false)
})
test('invalid Zod schema is rejected before staging', async () => {
  assert.throws(() => convertZodV3ToolSchema({ _def: { typeName: 'ZodObject' } }), /parse/)
  const result = await prepareZodV3LegacyTools([plugin('bad', { _def: { typeName: 'ZodObject' } }, () => '')], { makeInvocation })
  assert.equal(result.snapshot.failures.length, 1)
  assert.equal(result.prepared.length, 0)
})
test('tool failures stay isolated per plugin', async () => {
  const result = await prepareZodV3LegacyTools([
    plugin('bad', { _def: { typeName: 'ZodObject' } }, () => ''),
    plugin('good', schema(), () => 'ok'),
  ], { makeInvocation })
  assert.equal(result.snapshot.failures.length, 1)
  assert.equal(result.prepared.length, 1)
  assert.deepEqual(await result.prepared[0].definition.execute({ mood: 'happy' }, {}), { content: 'ok' })
})
test('requires invocation mapper before staging', async () => {
  await assert.rejects(prepareZodV3LegacyTools([]), /makeInvocation/)
})

test('parser comes from accepted plugin after a rejected duplicate', async () => {
  const rejected = plugin('bad', { _def: { typeName: 'ZodObject' }, parse: () => ({ mood: 'WRONG' }) }, () => 'bad')
  const good = plugin('good', schema(), args => args.mood)
  const { prepared } = await prepareZodV3LegacyTools([rejected, good], { makeInvocation })
  assert.deepEqual(await prepared[0].definition.execute({ mood: 'right' }, {}), { content: 'right' })
})

test('duplicate diagnostic plugin IDs cannot substitute a rejected plugin parser', async () => {
  const rejected = plugin('same', { _def: { typeName: 'ZodObject' }, parse: () => ({ mood: 'wrong' }) }, () => 'bad')
  const good = plugin('same', schema(), args => args.mood)
  const { snapshot, prepared } = await prepareZodV3LegacyTools([rejected, good], { makeInvocation })
  assert.equal(snapshot.failures.length, 1)
  assert.equal(prepared.length, 1)
  assert.deepEqual(await prepared[0].definition.execute({ mood: 'correct' }, {}), { content: 'correct' })
})

test('accepted descriptor retains its original parser if the source registry changes', async () => {
  const source = plugin('original', schema(), args => args.mood)
  const { prepared } = await prepareZodV3LegacyTools([source], { makeInvocation })
  source.hooks.tool.setMood.args = { parse: () => ({ mood: 'mutated' }) }
  assert.deepEqual(await prepared[0].definition.execute({ mood: 'stable' }, {}), { content: 'stable' })
})
