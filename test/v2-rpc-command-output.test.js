import test from 'node:test'
import assert from 'node:assert/strict'
import { commandOutputRpcDefinition, commandPartsToText, registerRpcCommandOutput, createCommandOutputTuiCompanion } from '../src/v2-rpc-command-output.js'
import { createRpcDeliveredNativeV2BridgeDefinition } from '../src/v2-rpc-native-bridge.js'

function mockRpc() {
  const emitted = []
  let disposed = 0
  let definition
  return { emitted, get disposed() { return disposed }, get definition() { return definition },
    ctx: { rpc: { async register(def, handlers) { definition = def; assert.deepEqual(handlers, {}); return { events: { async emit(...args) { emitted.push(args) } }, async dispose() { disposed++ } } } } } }
}

test('RPC definition uses v2.0.27 portable event schema', () => {
  assert.equal(commandOutputRpcDefinition.id, 'opencode-v1-bridge.command-output')
  assert.deepEqual(commandOutputRpcDefinition.methods, {})
  assert.equal(commandOutputRpcDefinition.events.output.schema.type, 'object')
})
test('text parts preserve order; non-text parts never silently dropped', () => {
  assert.equal(commandPartsToText([{type:'text',text:'a'}, {type:'text',text:'b'}]), 'a\nb')
  assert.throws(() => commandPartsToText([{type:'image',data:'x'}]), /non-text/)
})
test('RPC emits session-scoped output without model calls, and closes', async () => {
  const mock = mockRpc()
  const transport = await registerRpcCommandOutput(mock.ctx)
  await transport.deliver({sessionID:'s1',command:'mood',parts:[{type:'text',text:'calm'}]})
  assert.deepEqual(mock.emitted, [['output',{sessionID:'s1',command:'mood',text:'calm'}]])
  await transport.dispose(); await transport.dispose()
  assert.equal(mock.disposed, 1)
  await assert.rejects(transport.deliver({sessionID:'s1',command:'mood',parts:[]}),/closed/)
})
test('missing RPC capability fails closed', async () => {
  await assert.rejects(registerRpcCommandOutput({}),/ctx.rpc.register/)
})
test('TUI companion subscribes, uses toast and unsubscribes', async () => {
  let handler, unsubs = 0
  const shown = []
  const definitionSeen = []
  const companion = createCommandOutputTuiCompanion()
  const cleanup = companion.setup({client:{rpc(def) { definitionSeen.push(def); return {events:{on(name, fn) { assert.equal(name,'output'); handler=fn; return ()=>{unsubs++} }}} }},ui:{toast:{show: x=>shown.push(x)}}})
  assert.equal(definitionSeen[0], commandOutputRpcDefinition)
  await handler({data:{sessionID:'s1',command:'personality',text:'active'}})
  assert.deepEqual(shown,[{title:'/personality',message:'active',variant:'info',sessionID:'s1'}])
  cleanup();cleanup(); assert.equal(unsubs,1)
  await handler({data:{sessionID:'s2',command:'mood',text:'quiet'}})
  assert.equal(shown.length,1)
})
test('long results are explicitly reported, never silently truncated', async () => {
  let handler; const shown=[]
  createCommandOutputTuiCompanion({maxToastLength:3}).setup({client:{rpc:()=>({events:{on(_name, fn){handler=fn;return ()=>{}}}})},ui:{toast:{show: x=>shown.push(x)}}})
  await handler({data:{sessionID:'s',command:'mood',text:'long output'}})
  assert.match(shown[0].message,/not displayed/)
  assert.equal(shown[0].sessionID,'s')
})
test('native wrapper refuses missing RPC before loading legacy plugins', async () => {
  const plugin = createRpcDeliveredNativeV2BridgeDefinition({targets:['fake.js'],makeLegacyInput:()=>({}),bindings:{}})
  await assert.rejects(plugin.setup({location:{directory:'/tmp'}}),/ctx.rpc.register/)
})
test('native wrapper rolls back RPC registration when legacy setup fails', async () => {
  const mock=mockRpc()
  const plugin=createRpcDeliveredNativeV2BridgeDefinition({targets:['does-not-exist.js'],baseDirectory:'/tmp',makeLegacyInput:()=>({}),bindings:{}})
  await assert.rejects(plugin.setup({...mock.ctx,location:{directory:'/tmp'}}))
  assert.equal(mock.disposed,1)
})
test('default personality/mood commands execute through native transform into RPC event', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir=await mkdtemp(join(tmpdir(),'bridge60-'))
  const target=join(dir,'legacy.mjs')
  await writeFile(target, `export default async () => ({'command.execute.before': async (input,output) => { output.parts.push({type:'text',text:input.command+' '+input.arguments}) }})`)
  const mock=mockRpc()
  const registered=[]
  let commandDisposed=0
  const ctx={...mock.ctx,location:{directory:dir},command:{transform: async callback => { callback({add: item=>registered.push(item)});return {dispose:async()=>{commandDisposed++}}}}}
  const plugin=createRpcDeliveredNativeV2BridgeDefinition({targets:[target],baseDirectory:dir,makeLegacyInput:()=>({}),bindings:{}})
  try {
    const cleanup=await plugin.setup(ctx)
    assert.deepEqual(registered.map(x=>x.name),['personality','mood'])
    await registered[0].execute({sessionID:'one',prompt:{text:'list --all'},delivery:'queue'})
    await registered[1].execute({sessionID:'two',prompt:{text:'happy'},delivery:'steer'})
    assert.deepEqual(mock.emitted,[
      ['output',{sessionID:'one',command:'personality',text:'personality list --all'}],
      ['output',{sessionID:'two',command:'mood',text:'mood happy'}],
    ])
    await cleanup();await cleanup()
    assert.equal(mock.disposed,1)
    assert.equal(commandDisposed,1)
  } finally {await rm(dir,{recursive:true,force:true})}
})
