/** Exact v2.0.27 Promise-context subset. Never constructs an HTTP client from a guessed URL. */
import {isAbsolute,normalize} from 'node:path'
import {UnsupportedLegacyAPIError} from './legacy-context.js'
import {createLegacyLifetime} from './legacy-lifecycle.js'
import {V1_CLIENT_METHOD_PATHS} from './legacy-client-methods.js'
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)
function plain(value,label,allowed){
  if(!record(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' must be a plain record')
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!allowed.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+': unsupported property '+String(key))}
  return value
}
const absent=api=>{throw new UnsupportedLegacyAPIError(api)}
const absolute=(v,label)=>{if(typeof v!=='string'||!isAbsolute(v))throw new TypeError(label+' must be an absolute path');return v}
function scope(ctx){
  if(!record(ctx)||!record(ctx.location)||!record(ctx.location.project))throw new TypeError('Native location and project reference are required')
  const l=ctx.location,p=l.project
  if(typeof p.id!=='string'||!p.id)throw new TypeError('Native project.id is required')
  if(l.workspaceID!==undefined&&(typeof l.workspaceID!=='string'||!l.workspaceID))throw new TypeError('Invalid native workspaceID')
  return Object.freeze({directory:absolute(l.directory,'location.directory'),worktree:absolute(p.directory,'location.project.directory'),canonical:absolute(p.canonical,'location.project.canonical'),projectID:p.id,workspaceID:l.workspaceID})
}
const samePath=(a,b)=>typeof a==='string'&&normalize(a)===normalize(b)
/** VCS response boundary only. Snapshot descriptors once; Proxy inspection may still execute traps. */
function vcsResponseRecord(value,label,allowed,required=[]){
  if(!record(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' must be a plain record')
  const descriptors=Object.getOwnPropertyDescriptors(value),snapshot=Object.create(null)
  for(const key of Reflect.ownKeys(descriptors)){
    const descriptor=descriptors[key]
    if(typeof key!=='string'||!allowed.includes(key)||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': unsupported data property')
    snapshot[key]=descriptor.value
  }
  for(const key of required)if(!Object.hasOwn(snapshot,key))throw new TypeError(label+': missing required '+key)
  return snapshot
}

/** Fresh per legacy factory/activation; no native registrations, global cache or session selection. */
export function createNativeLegacyInputResource(ctx,options={}){
  plain(options,'native PluginInput options',['clientOptions'])
  const clientOptions=options.clientOptions===undefined?{}:options.clientOptions
  const owner=scope(ctx),selected={...plain(clientOptions,'clientOptions',['responseStyle','throwOnError'])}
  if(selected.responseStyle!==undefined&&!['fields','data'].includes(selected.responseStyle))throw new TypeError('Invalid responseStyle')
  if(selected.throwOnError!==undefined&&typeof selected.throwOnError!=='boolean')throw new TypeError('Invalid throwOnError')
  const lifetime=createLegacyLifetime('Native legacy PluginInput')
  const vcsOwner=ctx.vcs,vcsGet=vcsOwner?.get
  const assertOwned=()=>{lifetime.assertActive();const now=scope(ctx);if(ctx.vcs!==vcsOwner||ctx.vcs?.get!==vcsGet)throw new TypeError('Native PluginInput VCS capability ownership changed');if(Object.keys(owner).some(k=>owner[k]!==now[k]))throw new TypeError('Native PluginInput location ownership changed')}
  const methods=Object.create(null)
  methods['vcs.get']=request=>{
    let options
    try{
      options={...plain(request===undefined?{}:request,'client.vcs.get options',['responseStyle','throwOnError','query','signal'])}
      if(options.responseStyle!==undefined&&!['fields','data'].includes(options.responseStyle))throw new TypeError('Invalid responseStyle')
      if(options.throwOnError!==undefined&&typeof options.throwOnError!=='boolean')throw new TypeError('Invalid throwOnError')
      if(options.query!==undefined)options.query={...plain(options.query,'client.vcs.get query',['directory'])}
    }catch(cause){return Promise.reject(cause)}
    return lifetime.run(async()=>{
    assertOwned()
    // Public in-process API has no HTTP Request/Response envelope and ignores RequestOptions.signal.
    if(options.signal!==undefined)absent('client.vcs.get signal: native Promise adapter has no cancellation forwarding')
    if((options.responseStyle??selected.responseStyle??'fields')!=='data'||(options.throwOnError??selected.throwOnError??false)!==true)absent('client.vcs.get requires responseStyle=data and throwOnError=true; native HTTP envelope/error mode unavailable')
    if(options.query!==undefined){const q=plain(options.query,'client.vcs.get query',['directory']);if(q.directory!==undefined&&!samePath(q.directory,owner.directory))throw new TypeError('Cross-location client request rejected')}
    if(typeof vcsGet!=='function')absent('client.vcs.get: native vcs.get unavailable')
    const pending=Reflect.apply(vcsGet,vcsOwner,[])
    if(!pending||typeof pending.then!=='function')throw new TypeError('Native vcs.get must return a Promise; Effect contexts require the supported Promise adapter')
    const result=await pending
    assertOwned()
    const response=vcsResponseRecord(result,'Native VCS response',['location','data'],['location','data'])
    const location=vcsResponseRecord(response.location,'Native VCS location',['directory'],['directory'])
    if(!samePath(location.directory,owner.directory))throw new TypeError('Malformed or foreign native VCS response')
    const info=vcsResponseRecord(response.data,'Native VCS info',['provider','branch'],['branch'])
    const branch=vcsResponseRecord(info.branch,'Native VCS branch',['current','default'])
    const provider=info.provider,current=branch.current,defaultBranch=branch.default
    for(const [field,value]of [['provider',provider],['current',current],['default',defaultBranch]])if(value!==undefined&&typeof value!=='string')throw new TypeError('Native VCS '+field+' must be a string when defined')
    // Valid native absence/non-Git state is distinct from a malformed response.
    if(provider!=='git'||current===undefined||current==='')absent('client.vcs.get: native state has no supported Git branch projection')
    // Descriptor traps can execute caller code; attest ownership again after inspection.
    assertOwned()
    return {branch:current}
    })
  }
  // Registered identity discovery is a public location-scoped read, not a model tool snapshot.
  const toolOwner=ctx.tool,toolList=toolOwner?.list
  const assertToolOwned=()=>{
    lifetime.assertActive()
    const now=scope(ctx)
    if(Object.keys(owner).some(key=>owner[key]!==now[key]))throw new TypeError('Native PluginInput location ownership changed')
    if(ctx.tool!==toolOwner||ctx.tool?.list!==toolList)throw new TypeError('Native PluginInput tool capability ownership changed')
  }
  methods['tool.ids']=request=>{
    let options
    try{
      options={...plain(request===undefined?{}:request,'client.tool.ids options',['responseStyle','throwOnError','query','signal'])}
      if(options.responseStyle!==undefined&&!['fields','data'].includes(options.responseStyle))throw new TypeError('Invalid responseStyle')
      if(options.throwOnError!==undefined&&typeof options.throwOnError!=='boolean')throw new TypeError('Invalid throwOnError')
      if(options.query!==undefined)options.query={...plain(options.query,'client.tool.ids query',['directory'])}
    }catch(error){return Promise.reject(error)}
    return lifetime.run(async()=>{
      assertToolOwned()
      if(options.signal!==undefined)absent('client.tool.ids signal: native tool.list has no cancellation forwarding')
      if((options.responseStyle??selected.responseStyle??'fields')!=='data'||(options.throwOnError??selected.throwOnError??false)!==true)absent('client.tool.ids requires responseStyle=data and throwOnError=true; native HTTP envelope/error mode unavailable')
      if(options.query?.directory!==undefined&&!samePath(options.query.directory,owner.directory))throw new TypeError('Cross-location client request rejected')
      if(typeof toolList!=='function')absent('client.tool.ids: native tool.list unavailable')
      const pending=Reflect.apply(toolList,toolOwner,[])
      if(!pending||typeof pending.then!=='function')throw new TypeError('Native tool.list must return a Promise; Effect contexts require the supported Promise adapter')
      const entries=await pending
      assertToolOwned()
      if(!Array.isArray(entries))throw new TypeError('Malformed native tool.list response: expected registered-tool array')
      // Inspect the real array length once, never a caller-controlled ordinary get.
      const lengthProperty=Object.getOwnPropertyDescriptor(entries,'length')
      if(!lengthProperty||!Object.hasOwn(lengthProperty,'value'))throw new TypeError('Malformed native tool.list array length')
      const length=lengthProperty.value
      if(!Number.isInteger(length)||length<0||length>0xffffffff)throw new TypeError('Malformed native tool.list array length')
      // Dense own indices must agree with the captured length. Non-index metadata is not read.
      const indices=new Set()
      for(const key of Reflect.ownKeys(entries))if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<0xffffffff){
        if(Number(key)>=length)throw new TypeError('Inconsistent native tool.list array indices')
        indices.add(key)
      }
      if(indices.size!==length)throw new TypeError('Sparse native tool.list array unsupported')
      const snapshot=[]
      for(let index=0;index<length;index++){
        const slot=Object.getOwnPropertyDescriptor(entries,String(index))
        if(!slot||!Object.hasOwn(slot,'value'))throw new TypeError('Malformed native tool.list entry')
        const entry=slot.value
        if(!record(entry))throw new TypeError('Malformed native tool.list entry')
        snapshot.push(entry)
      }
      const ids=[],seen=new Set()
      for(let index=0;index<length;index++){
        const property=Object.getOwnPropertyDescriptor(snapshot[index],'id')
        if(!property||!Object.hasOwn(property,'value'))throw new TypeError('Malformed native effective tool ID')
        const id=property.value
        if(typeof id!=='string'||id.length===0||seen.has(id))throw new TypeError('Malformed or duplicate native effective tool ID')
        seen.add(id);ids.push(id)
      }
      // Inspection can execute Proxy traps, so attest ownership again before publishing IDs.
      assertToolOwned()
      return ids
    })
  }
  // V1 Agent requires provenance/tools/options and a legacy permission object that
  // public V2 Agent.Info cannot reconstruct. Never fabricate nonempty Agent[].
  const agentOwner=ctx.agent,agentList=agentOwner?.list
  const assertAgentOwned=()=>{
    lifetime.assertActive()
    const now=scope(ctx)
    if(Object.keys(owner).some(key=>owner[key]!==now[key]))throw new TypeError('Native PluginInput location ownership changed')
    if(ctx.agent!==agentOwner||ctx.agent?.list!==agentList)throw new TypeError('Native PluginInput agent capability ownership changed')
  }
  methods['app.agents']=request=>{
    let options
    try{
      options={...plain(request===undefined?{}:request,'client.app.agents options',['responseStyle','throwOnError','query','signal'])}
      if(options.responseStyle!==undefined&&!['fields','data'].includes(options.responseStyle))throw new TypeError('Invalid responseStyle')
      if(options.throwOnError!==undefined&&typeof options.throwOnError!=='boolean')throw new TypeError('Invalid throwOnError')
      if(options.query!==undefined)options.query={...plain(options.query,'client.app.agents query',['directory'])}
    }catch(error){return Promise.reject(error)}
    return lifetime.run(async()=>{
      assertAgentOwned()
      if(options.signal!==undefined)absent('client.app.agents signal: native Promise adapter has no cancellation forwarding')
      if((options.responseStyle??selected.responseStyle??'fields')!=='data'||(options.throwOnError??selected.throwOnError??false)!==true)absent('client.app.agents requires responseStyle=data and throwOnError=true; native HTTP envelope/error mode unavailable')
      if(options.query?.directory!==undefined&&!samePath(options.query.directory,owner.directory))throw new TypeError('Cross-location client request rejected')
      if(typeof agentList!=='function')absent('client.app.agents: native agent.list unavailable')
      const pending=Reflect.apply(agentList,agentOwner,[{location:{directory:owner.directory}}])
      if(!pending||typeof pending.then!=='function')throw new TypeError('Native agent.list must return a Promise; Effect contexts require the supported Promise adapter')
      const result=await pending
      assertAgentOwned()
      plain(result,'native agent response',['location','data'])
      plain(result.location,'native agent response location',['directory'])
      if(!samePath(result.location.directory,owner.directory)||!Array.isArray(result.data))throw new TypeError('Malformed or foreign native agent response')
      if(result.data.length)absent('client.app.agents nonempty result: public V2 Agent.Info cannot faithfully supply required V1 builtIn, tools, options and permission semantics')
      return []
    })
  }
  const tree=Object.create(null)
  for(const methodPath of V1_CLIENT_METHOD_PATHS){const keys=methodPath.split('.');let node=tree;for(const key of keys.slice(0,-1))node=node[key]??=(Object.create(null));node[keys.at(-1)]=methods[methodPath]??((..._args)=>lifetime.run(()=>absent('client.'+methodPath)))}
  function seal(node,prefix){for(const key of Object.keys(node))if(typeof node[key]!=='function')node[key]=seal(node[key],prefix+'.'+key);Object.freeze(node);return new Proxy(node,{get(target,key,receiver){if(key==='then')return undefined;if(typeof key==='symbol')return Reflect.get(target,key,receiver);if(!Object.hasOwn(target,key))absent(prefix+'.'+key);return Reflect.get(target,key,receiver)}})}
  const client=seal(tree,'client'),project={id:owner.projectID,worktree:owner.canonical}
  for(const field of ['time','vcs','vcsDir'])Object.defineProperty(project,field,{enumerable:true,get(){assertOwned();return absent('project.'+field+': not supplied by native Location.Info')}})
  Object.freeze(project)
  const workspace=Object.freeze({register(){assertOwned();return absent('experimental_workspace.register: V1 workspace adapters are not V2 worktree strategies')}})
  const shell=new Proxy(()=>absent('$: BunShell unavailable in native Promise context'),{get(_t,k){return absent('$.'+String(k))}})
  const input={directory:owner.directory,worktree:owner.worktree,project,client,experimental_workspace:workspace,$:shell}
  Object.defineProperty(input,'serverUrl',{enumerable:true,get(){assertOwned();return absent('serverUrl: native plugin Context does not expose its server endpoint')}})
  return Object.freeze({input:Object.freeze(input),dispose:()=>lifetime.finish(),get pending(){return lifetime.pending}})
}