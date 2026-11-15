import { copy, record, LEGACY_TITLE_METADATA_KEY } from './tool-result-data.js'
import {durableLegacyMetadata,legacyMetadataView,isLegacyMetadata,sameMetadataData} from './legacy-metadata-durability.js'
/** V1 tool hooks on the supported v2.0.27 Promise ToolDomain. */
export class LegacyToolHookError extends Error {
  constructor(code, phase, plugin, cause) {
    super(`Legacy tool hook ${phase}${plugin ? ` (${plugin})` : ''}: ${code}${cause ? ': '+cause.message : ''}`, { cause })
    this.name = 'LegacyToolHookError'
    this.code = code
    this.phase = phase
    this.plugin = plugin
  }
}
// Exact host CodeModeTool.create.name; verified by the source-contract check.
export const CODE_MODE_GATEWAY_NAME = 'execute'
export { LEGACY_TITLE_METADATA_KEY } from './tool-result-data.js'
const error = (code, phase, plugin, cause) => new LegacyToolHookError(code, phase, plugin, cause)
function freeze(value) {
  if (value && typeof value === 'object') { for (const key of Object.keys(value)) freeze(value[key]); Object.freeze(value) }
  return value
}
// Descriptor reads avoid ordinary getters; Proxy inspection can still execute caller code.
function ownData(value,key,label,required=false) {
  if(value===null||typeof value!=='object')throw new TypeError(label+' requires an object')
  const property=Object.getOwnPropertyDescriptor(value,key)
  if(!property){if(required)throw new TypeError(label+' requires own '+key);return undefined}
  if(!Object.hasOwn(property,'value'))throw new TypeError(label+' requires data '+key)
  return property.value
}
const identityKeys=['tool','sessionID','agent','messageID','id']
function identity(event) {
  if(!record(event))throw new TypeError('Native tool/session/message/call identity is required')
  const snapshot={}
  for(const key of identityKeys){const value=ownData(event,key,'Native tool identity',true);if(typeof value!=='string'||!value)throw new TypeError('Native tool/session/message/call identity is required');snapshot[key]=value}
  return Object.freeze(snapshot)
}
function locationOwner(ctx) {
  const location=ownData(ctx,'location','Native hook context')
  if(location===undefined)return undefined // Minimal tool-only ports remain supported.
  const project=ownData(location,'project','Native hook location',true)
  const snapshot={location,project,directory:ownData(location,'directory','Native hook location',true),workspaceID:ownData(location,'workspaceID','Native hook location'),projectID:ownData(project,'id','Native hook project',true),worktree:ownData(project,'directory','Native hook project',true),canonical:ownData(project,'canonical','Native hook project',true)}
  for(const key of ['directory','projectID','worktree','canonical'])if(typeof snapshot[key]!=='string'||!snapshot[key])throw new TypeError('Malformed native hook location')
  if(snapshot.workspaceID!==undefined&&(typeof snapshot.workspaceID!=='string'||!snapshot.workspaceID))throw new TypeError('Malformed native hook workspace')
  return Object.freeze(snapshot)
}
function registeredSnapshot(tools,target,phase) {
  const label='Malformed native tool registry'
  if(!Array.isArray(tools))throw new TypeError(label)
  const length=ownData(tools,'length',label,true)
  if(!Number.isInteger(length)||length<0||length>0xffffffff)throw new TypeError(label)
  const indices=new Set()
  for(const key of Reflect.ownKeys(tools))if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<0xffffffff){if(Number(key)>=length)throw new TypeError(label);indices.add(key)}
  if(indices.size!==length)throw new TypeError(label)
  const entries=[]
  for(let index=0;index<length;index++)entries.push(ownData(tools,String(index),label,true))
  const registry=new Map()
  for(const entry of entries){
    if(!record(entry))throw new TypeError(label)
    const id=ownData(entry,'id',label,true),name=ownData(entry,'name',label,true)
    if(typeof id!=='string'||!id||typeof name!=='string'||!name||registry.has(id))throw new TypeError(label)
    registry.set(id,{id,name,entry})
  }
  const selected=registry.get(target)
  if(!selected)return undefined
  if(target===CODE_MODE_GATEWAY_NAME){
    const options=ownData(selected.entry,'options',label)
    if(options!==undefined&&!record(options))throw new TypeError(label+' options')
    const codemode=options===undefined?undefined:ownData(options,'codemode',label)
    if(codemode!==undefined&&typeof codemode!=='boolean')throw new TypeError(label+' codemode')
    if(codemode!==false)throw error('ambiguous CodeMode gateway/registered-tool identity','dispatch')
  }
  const hasOutput=phase==='after'&&ownData(selected.entry,'output',label)!==undefined
  return Object.freeze({id:selected.id,name:selected.name,hasOutput})
}
function assertOutput(output) {
  if (!record(output) || typeof output.title !== 'string' || typeof output.output !== 'string' || !record(output.metadata)) throw new TypeError('V1 after output requires title/output strings and record metadata')
  if (Object.keys(output).some(key=>!['title','output','metadata'].includes(key))) throw new TypeError('Unsupported V1 after output field')
  if (Object.hasOwn(output.metadata,LEGACY_TITLE_METADATA_KEY)) throw new TypeError('Legacy metadata collides with reserved bridge title envelope')
  return copy(output)
}

/**
 * Scope: tools present in ctx.tool.list(), including registered native tools and
 * CodeMode leaves. The synthesized CodeMode gateway is not in that registry and
 * has no V1 leaf counterpart. No name/plugin-specific filtering is used.
 * Before = mutate detached args before host validation/authorization/execution.
 * After = successful text-view result only, preserving file parts and metadata.
 * Native schema values remain canonical/read-only; metadata/title edits are
 * supported, but diverging text edits require a validated projection and fail.
 * Host Promise hook API has no signal. Interruption remains host-owned; disposal
 * prevents late commits but cannot cancel arbitrary legacy JavaScript side effects.
 */
export async function registerLegacyToolHooks(ctx, plugins) {
  const domain=ownData(ctx,'tool','Native hook context',true),list=ownData(domain,'list','Native tool port',true),hook=ownData(domain,'hook','Native tool port',true),owner=locationOwner(ctx)
  if(typeof list!=='function'||typeof hook!=='function')throw error('native tool.hook and tool.list required','registration')
  if (!Array.isArray(plugins)) throw new TypeError('plugins must be an array')
  const callbacks = {before:[],after:[]}
  for (const [index,plugin] of plugins.entries()) {
    if (!record(plugin?.hooks)) throw new TypeError('Expected initialized legacy hooks')
    for (const phase of ['before','after']) {
      const d=Object.getOwnPropertyDescriptor(plugin.hooks,`tool.execute.${phase}`)
      if (!d) continue
      if (!Object.hasOwn(d,'value') || typeof d.value !== 'function') throw new TypeError(`tool.execute.${phase} must be a function data property`)
      callbacks[phase].push({id:String(plugin.id??plugin.target??`legacy-${index}`),hook:d.value.bind(plugin.hooks)})
    }
  }
  let disposed=false
  const cancellation=new AbortController(),active=new Set(),registrations=[]
  const assertActive=phase=>{
    if(disposed)throw error('disposed',phase)
    if(ownData(ctx,'tool','Native hook context',true)!==domain||ownData(domain,'list','Native tool port',true)!==list||ownData(domain,'hook','Native tool port',true)!==hook)throw error('native capability ownership changed',phase)
    const now=locationOwner(ctx)
    if(owner===undefined?now!==undefined:now===undefined||Object.keys(owner).some(key=>owner[key]!==now[key]))throw error('native location ownership changed',phase)
    if(disposed)throw error('disposed',phase)
  }
  const registered=phase=>{
    assertActive(phase)
    return Reflect.apply(list,domain,[])
  }
  const wait=async(promise,phase)=>{
    let abort
    const stopped=new Promise((_,reject)=>{
      abort=()=>reject(error('disposed',phase))
      if(cancellation.signal.aborted)abort()
      else cancellation.signal.addEventListener('abort',abort,{once:true})
    })
    // Attach handlers even when cleanup happened during promise creation.
    try { const value=await Promise.race([Promise.resolve(promise),stopped]);assertActive(phase);return value }
    finally { cancellation.signal.removeEventListener('abort',abort) }
  }
  const runHooks=async(phase,hookInput,output,assertTurn)=>{
    let draft=output
    for (const entry of callbacks[phase]) {
      assertTurn()
      try {
        // Each turn gets a fresh detached draft. A retained prior reference cannot
        // change later hooks, the executor's eventual args or an authorization.
        await wait(Promise.resolve().then(()=>{assertTurn();return entry.hook(hookInput,draft)}),phase)
        assertTurn()
        const cloned=copy(draft)
        if(!record(cloned)||!Object.hasOwn(cloned,phase==='before'?'args':'output'))throw new TypeError('Missing V1 hook mutation object')
        draft=phase==='before'?{args:cloned.args}:assertOutput(cloned)
      } catch(cause) { if(cause instanceof LegacyToolHookError)throw cause;throw error('callback failed or unsupported mutation',phase,entry.id,cause) }
    }
    return draft
  }
  const execute=async(phase,event)=>{
    assertActive(phase)
    const native=identity(event),hookIdentity=Object.freeze({tool:native.tool,sessionID:native.sessionID,callID:native.id})
    const assertTurn=()=>{
      assertActive(phase)
      const now=identity(event)
      if(identityKeys.some(key=>now[key]!==native[key]))throw error('native event identity changed',phase)
      assertActive(phase)
    }
    const tools = await wait(registered(phase),phase)
    assertTurn()
    // Local synchronous inspection is outside the cancellable native read race.
    const tool=registeredSnapshot(tools,native.tool,phase)
    assertTurn()
    if (!tool) return // explicitly defined registered-tool scope
    if(phase==='before') {
      if(!callbacks.before.length)return
      const output=await runHooks(phase,hookIdentity,{args:copy(event.input)},assertTurn)
      const nextInput=copy(output.args)
      assertTurn()
      event.input=nextInput
      return
    }
    if(event.status==='error') return // V1 has no after-error contract; never fabricate success
    if(event.status!=='completed' || !record(event.result)) throw error('invalid native completion','after')
    const result=event.result
    // Native schema values are not V1 text. Snapshot them before any async hook;
    // never reinterpret them, re-run the tool, or pretend display edits changed them.
    const hasCanonical=Object.hasOwn(result,'output')
    const canonical=hasCanonical?copy(result.output):undefined
    const structured=tool.hasOutput||hasCanonical
    const parts=typeof result.content==='string'?[{type:'text',text:result.content}]:copy(result.content??[])
    if(!Array.isArray(parts)||parts.some(p=>!record(p)||!['text','file'].includes(p.type)||(p.type==='text'&&typeof p.text!=='string'))) throw error('unsupported native content','after')
    const text=parts.filter(p=>p.type==='text').map(p=>p.text).join('\n')
    const legacyOrigin=isLegacyMetadata(result.metadata)
    const metadata=legacyMetadataView(result.metadata??{})
    if(!record(metadata))throw error('invalid native metadata','after')
    let title=''
    const hadEnvelope=Object.hasOwn(metadata,LEGACY_TITLE_METADATA_KEY)
    if(hadEnvelope) {
      const envelope=metadata[LEGACY_TITLE_METADATA_KEY]
      if(!record(envelope)||envelope.version!==1||typeof envelope.title!=='string'||Object.keys(envelope).some(k=>!['version','title'].includes(k)))throw error('reserved title envelope collision','after')
      title=envelope.title
      delete metadata[LEGACY_TITLE_METADATA_KEY]
    }
    const originalMetadata=copy(metadata), originalTitle=title
    const hookInput=Object.freeze({...hookIdentity,args:freeze(copy(event.input))})
    const output=await runHooks(phase,hookInput,{title,output:text,metadata},assertTurn)
    if(structured && output.output!==text) throw error('native structured output text mutation requires a validated projection','after')
    let content=parts
    if(output.output!==text){
      let inserted=false
      content=parts.flatMap(part=>{if(part.type!=='text')return[part];if(inserted)return[];inserted=true;return[{type:'text',text:output.output}]})
      if(!inserted)content.push({type:'text',text:output.output})
    }
    let nextMetadata=copy(output.metadata)
    if(hadEnvelope||output.title!=='')nextMetadata[LEGACY_TITLE_METADATA_KEY]={version:1,title:output.title}
    // Last owned mutation boundary. Leave untouched native V2 metadata alone;
    // validate legacy-origin values and changes made by our legacy callbacks.
    if(legacyOrigin || originalTitle!==output.title || !sameMetadataData(originalMetadata,output.metadata)) {
      try { nextMetadata=durableLegacyMetadata(nextMetadata) }
      catch(cause) { throw error('invalid durable metadata','after',undefined,cause) }
    }
    assertTurn()
    event.result={...result,...(hasCanonical?{output:canonical}:{}),content:copy(content),...(result.metadata!==undefined||Object.keys(nextMetadata).length?{metadata:nextMetadata}:{})}
  }
  const dispatch=(phase,event)=>{
    const job=execute(phase,event)
    active.add(job)
    job.then(()=>active.delete(job),()=>active.delete(job))
    return job
  }
  let disposal
  const dispose=()=>{
    if(disposal)return disposal
    disposed=true
    cancellation.abort()
    disposal=(async()=>{
      const outcomes=await Promise.allSettled(registrations.slice().reverse().map(handle=>Promise.resolve().then(()=>handle.dispose())))
      await Promise.allSettled([...active])
      const failures=outcomes.filter(o=>o.status==='rejected').map(o=>o.reason)
      if(failures.length)throw new AggregateError(failures,'Legacy tool hook cleanup failed')
    })()
    return disposal
  }
  try {
    for(const phase of ['before','after'])if(callbacks[phase].length || (phase==='before' && callbacks.after.length)){
      assertActive(phase)
      const handle=await Reflect.apply(hook,domain,[`execute.${phase}`,event=>dispatch(phase,event)])
      if(typeof handle?.dispose!=='function')throw error('native hook did not return a disposable registration',phase)
      registrations.push(handle)
      assertActive(phase)
    }
    return Object.freeze({dispose})
  }catch(cause){
    try{await dispose()}catch(cleanup){throw new AggregateError([cause,cleanup],'Legacy tool hook registration and rollback failed')}
    throw cause
  }
}
