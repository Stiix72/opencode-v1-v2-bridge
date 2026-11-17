import assert from 'node:assert/strict'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createServerPlugin, ServerActivationError } from '../server.js'
import { translateLegacyTools } from '../src/legacy-tools.js'
import { createV2027AssistantEventMapper } from '../src/v2-assistant-events.js'
import { makeV2ToolDefinition } from '../src/v2-tool-definition.js'

async function mockHost(t, version) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-host-'))
  const file = join(directory, 'fixture-plugin.mjs')
  t.after(async () => { await rm(file, { force: true }); await rmdir(directory) })
  await writeFile(file, `
    export let disposals = 0, client
    export default async input => {
      client = input.client
      return {
        tool: {
          fixture_echo: {
            description: 'Synthetic legacy tool',
            args: {},
            async execute(_args, context) { return 'echo ' + context.sessionID }
          }
        },
        dispose() { disposals++ }
      }
    }
  `)
  const editors = new Set()
  const project = { id: 'project', directory, canonical: directory }
  const ctx = {
    app: { version },
    options: { version: 1, clientOptions: { responseStyle: 'data', throwOnError: true },
      targets: [{ id: 'example', module: './fixture-plugin.mjs' }] },
    location: { directory, project },
    tool: {
      async list() {
        const tools = [{ id: 'unrelated' }]
        for (const edit of editors) edit({ list: () => tools, add: item => tools.push({ ...item, id: item.name }) })
        return tools
      },
      async transform(edit) {
        editors.add(edit)
        return { dispose: async () => { editors.delete(edit) } }
      },
      hook() { throw new Error('No tool hooks configured') },
    },
    session: {
      async get({ sessionID }) {
        return { id: sessionID, projectID: sessionID === 'foreign' ? 'other-project' : project.id, location: { directory } }
      },
      hook() { throw new Error('No session hooks configured') },
    },
    vcs: { async get() { return { location: { directory }, data: { provider: 'git', branch: { current: 'main' } } } } },
    agent: { async list(input) {
      assert.deepEqual(input, { location: { directory } })
      return { location: { directory }, data: [] }
    } },
  }
  return { ctx, file }
}

for (const version of ['2.3.0', '2.0.27']) {
  test(`public entrypoint activates, executes and reactivates with a mock ${version} host`, async t => {
    const { ctx, file } = await mockHost(t, version)
    const module = await import(pathToFileURL(file))
    const plugin = createServerPlugin()
    const close = await plugin.setup(ctx)
    const native = { sessionID: 'session', messageID: 'message', agent: 'build', id: 'call',
      signal: new AbortController().signal }
    const [unrelated, registered] = await ctx.tool.list()
    assert.equal(unrelated.id, 'unrelated')
    assert.equal(registered.id, 'fixture_echo')
    assert.equal(registered.options.codemode, false)
    assert.deepEqual(await registered.execute({}, native), { content: 'echo session' })
    await assert.rejects(registered.execute({}, { ...native, sessionID: 'foreign' }), /does not belong/)
    const client = module.client
    assert.deepEqual(await client.vcs.get(), { branch: 'main' })
    assert.deepEqual(await client.tool.ids(), ['unrelated', 'fixture_echo'])
    assert.deepEqual(await client.app.agents(), [])
    await assert.rejects(client.session.messages(), /not supported/)
    await assert.rejects(plugin.setup(ctx), ServerActivationError)
    await close()
    await close()
    assert.equal(module.disposals, 1)
    assert.deepEqual(await ctx.tool.list(), [{ id: 'unrelated' }])
    await assert.rejects(registered.execute({}, native), /disposed|stale/i)
    await assert.rejects(client.tool.ids(), /disposed/i)
    const reactivated = await plugin.setup(ctx)
    await reactivated()
    assert.equal(module.disposals, 2)
  })
}

test('unreviewed host versions fail before inspecting targets or host capabilities', async () => {
  const plugin = createServerPlugin()
  for (const version of [undefined, '2.3.1', '2.2.7', '2.3.0-beta.1']) {
    await assert.rejects(plugin.setup({ app: { version }, get options() { assert.fail('options read') } }),
      /requires OpenCode 2\.3\.0 or 2\.0\.27/)
  }
})

test('2.3.0 refuses CodeMode before acquiring registrations, while 2.0.27 retains it', async t => {
  const plugin = createServerPlugin()
  const modern = await mockHost(t, '2.3.0')
  modern.ctx.options.toolExposure = 'code-mode'
  Object.defineProperty(modern.ctx, 'tool', { get() { assert.fail('native tool domain acquired') } })
  await assert.rejects(plugin.setup(modern.ctx), /can expose CodeMode tools directly/)
  const legacy = await mockHost(t, '2.0.27')
  legacy.ctx.options.toolExposure = 'code-mode'
  const close = await plugin.setup(legacy.ctx)
  assert.equal((await legacy.ctx.tool.list())[1].options.codemode, true)
  await close()
})

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const toolDescriptor = execute => ({ name: 'fixture', inputSchema: { type: 'object' }, execute })

test('cooperative stop rejects a normal late return and leaves an original tool failure visible', async () => {
  for (const originalError of [undefined, new Error('original failure')]) {
    const stop = new AbortController(), entered = deferred(), finish = deferred()
    const tool = makeV2ToolDefinition(toolDescriptor(async () => {
      entered.resolve()
      await finish.promise
      if (originalError) throw originalError
      return 'late success'
    }), {
      makeInvocation: ctx => ({ abort: ctx.signal }),
      convertResult: () => assert.fail('cancelled result was converted'),
    })
    const execution = tool.execute({}, { get signal() { return stop.signal } })
    await entered.promise
    stop.abort()
    finish.resolve()
    await assert.rejects(execution, error => error === (originalError ?? stop.signal.reason))
  }
})

test('stop during an asynchronous result conversion prevents successful delivery', async () => {
  const stop = new AbortController(), converting = deferred(), finish = deferred()
  const tool = makeV2ToolDefinition(toolDescriptor(async () => 'result'), {
    makeInvocation: () => ({ abort: stop.signal }),
    async convertResult() {
      converting.resolve()
      await finish.promise
      return { content: 'result' }
    },
  })
  const execution = tool.execute({}, {})
  await converting.promise
  stop.abort()
  finish.resolve()
  await assert.rejects(execution, error => error === stop.signal.reason)
})

test('legacy execution and new metadata publication require a live native signal', async () => {
  const stop = new AbortController(), entered = deferred(), finish = deferred()
  let executions = 0, progress = 0
  const registry = await translateLegacyTools({ fixture: {
    args: { type: 'object' },
    async execute(_args, context) {
      executions++
      entered.resolve()
      await finish.promise
      assert.throws(() => context.metadata({ metadata: { test: true } }), error => error === stop.signal.reason)
      return 'stopped'
    },
  } })
  const invocation = { sessionID: 'session', messageID: 'message', agent: 'build', directory: tmpdir(),
    abort: stop.signal, metadata() { progress++ } }
  const execution = registry.fixture.execute({}, invocation)
  await entered.promise
  stop.abort()
  finish.resolve()
  await assert.rejects(execution, error => error === stop.signal.reason)
  await assert.rejects(registry.fixture.execute({}, invocation), error => error === stop.signal.reason)
  assert.equal(executions, 1)
  assert.equal(progress, 0)
})

test('2.3.0 first-token telemetry does not create a legacy assistant message', () => {
  const mapper = createV2027AssistantEventMapper()
  assert.equal(mapper.mapEvent({
    id: 'evt_first', created: 1, type: 'session.step.first-token',
    durable: { aggregateID: 'ses_fixture', seq: 3, version: 1 },
    data: { sessionID: 'ses_fixture', assistantMessageID: 'msg_fixture' },
  }), null)
  assert.equal(mapper.snapshot().messages, 0)
  assert.equal(mapper.snapshot().ignored, 1)
  assert.throws(() => mapper.mapEvent({ type: 'session.step.unknown' }), /Unsupported native event mapping/)
})
