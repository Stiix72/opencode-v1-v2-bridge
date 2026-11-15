import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createLegacyInput, createLegacyToolContext, UnsupportedLegacyAPIError } from '../src/legacy-context.js'
const root = resolve('/tmp/oc-v1-bridge-context')

test('input retains paths and forwards real client calls', async () => {
  const calls = []
  const input = createLegacyInput({ directory: root, worktree: root, log: async (x) => calls.push(['log', x]), showToast: async (x) => calls.push(['toast', x]) })
  await input.client.app.log({ body: 'hello' })
  await input.client.tui.showToast({ message: 'saved' })
  assert.deepEqual(calls, [['log', { body: 'hello' }], ['toast', { message: 'saved' }]])
  assert.equal(input.directory, root)
})

test('missing client capabilities fail loudly rather than silently succeed', async () => {
  const input = createLegacyInput({ directory: root })
  await assert.rejects(input.client.tui.showToast({ message: 'x' }), (err) => err instanceof UnsupportedLegacyAPIError && err.api === 'client.tui.showToast')
  await assert.rejects(input.client.app.log({}), /client.app.log/)
})

test('tool context maps identifiers and abort signal', () => {
  const controller = new AbortController()
  const ctx = createLegacyToolContext({ sessionID: 's', messageID: 'm', agent: 'build', directory: root, abort: controller.signal })
  assert.equal(ctx.abort, controller.signal)
  assert.equal(ctx.worktree, root)
  controller.abort()
  assert.equal(ctx.abort.aborted, true)
})

test('tool permission and metadata methods never silently allow actions', async () => {
  const ctx = createLegacyToolContext({ sessionID: 's', messageID: 'm', agent: 'build', directory: root })
  await assert.rejects(ctx.ask({ permission: 'write' }), /ToolContext.ask/)
  await assert.rejects(ctx.metadata({ title: 'x' }), /ToolContext.metadata/)
})

test('provided permission and metadata functions are forwarded', async () => {
  const calls = []
  const ctx = createLegacyToolContext({ sessionID: 's', messageID: 'm', agent: 'build', directory: root,
    ask: async x => { calls.push(['ask', x]) }, metadata: async x => { calls.push(['metadata', x]) } })
  await ctx.ask({ permission: 'read' })
  await ctx.metadata({ title: 'working' })
  assert.deepEqual(calls, [['ask', { permission: 'read' }], ['metadata', { title: 'working' }]])
})

test('rejects invalid paths and operations before plugin initialization', () => {
  assert.throws(() => createLegacyInput({ directory: 'relative' }), /absolute path/)
  assert.throws(() => createLegacyInput({ directory: root, log: true }), /log must be a function/)
  assert.throws(() => createLegacyToolContext({ sessionID: '', messageID: 'm', agent: 'a', directory: root }), /sessionID/)
})
