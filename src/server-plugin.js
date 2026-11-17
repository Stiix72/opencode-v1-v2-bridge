/** Installable OpenCode Promise plugin for the explicitly supported host versions. */
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {createPendingPermissionObserverMapper,snapshotPendingPermissionRequest} from './pending-permission-observer.js'
import {validateServerOptions,ServerConfigurationError} from './server-configuration.js'
import {resolveLegacyTarget} from './legacy-loader.js'
import {createNativeV2BridgeDefinition} from './v2-plugin-entrypoint.js'
import {createRpcDeliveredNativeV2BridgeDefinition} from './v2-rpc-native-bridge.js'
import {createNativeLegacyInputResource} from './native-plugin-input.js'
import {createCapabilityLegacyInputResource} from './legacy-client-capabilities.js'
import {ownerOf,assertOwner} from './client-capability-contract.js'
import {snapshotPermissionContext} from './v2-permission-binding.js'
import {UnsupportedLegacyAPIError} from './legacy-context.js'
import {createToolMetadataBinding} from './legacy-live-metadata.js'
import {createV2027AssistantEventMapper} from './v2-assistant-events.js'
import {createV2027SessionLifecycleEventMapper} from './v2-session-lifecycle-events.js'
import {createStderrLegacyLogger} from './v2-stderr-logging.js'
export {validateServerOptions,ServerConfigurationError}
const describe=(error,depth=0)=>depth>6?'nested error':error instanceof AggregateError?error.message+': '+error.errors.map(e=>describe(e,depth+1)).join('; '):String(error?.message??error)+(error?.cause?' -> '+describe(error.cause,depth+1):'')
export class ServerActivationError extends Error {
  constructor(message,cause){super(cause?message+': '+describe(cause):message,{cause});this.name='ServerActivationError';if(cause?.cleanupFailed)this.cleanupFailed=true}
}
const supportedHostVersions = ['2.3.0', '2.0.27']
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&
  (process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b))
const method=(ctx,domain,key)=>{
  const object=ctx?.[domain],value=object?.[key]
  if(typeof value!=='function')throw new ServerActivationError('Required public V2 capability unavailable: '+domain+'.'+key)
  return {object,value,call:(...args)=>Reflect.apply(value,object,args)}
}
const warning=(code,error)=>process.emitWarning(error instanceof Error?error:new Error(String(error)),{code})
/** The default definition is reusable; every host Context gets an independent activation. */
export function createServerPlugin(){
  const contexts=new WeakMap()
  return Object.freeze({id:'opencode-v1-bridge',async setup(ctx){
    if(!ctx||typeof ctx!=='object')throw new ServerActivationError('Native V2 Context required')
    if(contexts.has(ctx))throw new ServerActivationError('Context already active, initializing, disposing or quarantined')
    const state={phase:'initializing'};contexts.set(ctx,state)
    let close
    try{
      const version = ctx.app?.version
      if (!supportedHostVersions.includes(version)) {
        throw new ServerActivationError('This server entrypoint requires OpenCode ' + supportedHostVersions.join(' or '))
      }
      const config=validateServerOptions(ctx.options)
      // On 2.3.0 the scheduler may expose CodeMode tools directly when execute is denied.
      // The Promise plugin cannot require the gateway for each request.
      if (version === '2.3.0' && config.toolExposure === 'code-mode') {
        throw new ServerConfigurationError('OpenCode 2.3.0 can expose CodeMode tools directly; use direct tool exposure')
      }
      const owner=ownerOf(ctx)
      const location=ctx.location,project=location.project
      const required=[['tool','transform'],['tool','list'],['tool','hook'],['session','get'],['session','hook']]
      const hasPermissionObservers=config.targets.some(target=>target.pendingPermissionObserver===true)
      if(config.events||hasPermissionObservers)required.push(['event','subscribe'])
      if(hasPermissionObservers)required.push(['permission','list'])
      const hasCommands=config.targets.some(target=>target.commands)
      if(hasCommands)required.push(['command','transform'],['rpc','register'],['event','subscribe'])
      const methods=required.map(([domain,key])=>({domain,key,...method(ctx,domain,key)}))
      const sessionGet=methods.find(x=>x.domain==='session'&&x.key==='get').call
      const assertActive=()=>{
        if(state.phase!=='initializing'&&state.phase!=='active')throw new ServerActivationError('Server activation unavailable: '+state.phase)
        if(ctx.location!==location||ctx.location.project!==project)throw new ServerActivationError('Native activation location identity changed')
        assertOwner(ctx,owner)
        for(const x of methods)if(ctx[x.domain]!==x.object||x.object[x.key]!==x.value)throw new ServerActivationError('Native capability changed: '+x.domain+'.'+x.key)
      }
      async function sessionOwned(id,admitted){
        if(admitted&&!admitted())return null
        assertActive()
        const session=await sessionGet({sessionID:id})
        if(admitted&&!admitted())return null
        assertActive()
        if(session?.id!==id||session.projectID!==owner.projectID||!samePath(session.location?.directory,owner.directory)||
          session.location.workspaceID!==owner.workspaceID)throw new ServerActivationError('Session does not belong to this activation location/project')
        return session
      }
      const listed=await methods.find(x=>x.domain==='tool'&&x.key==='list').call()
      assertActive()
      if(!Array.isArray(listed)||Reflect.ownKeys(listed).length!==listed.length+1)throw new ServerActivationError('Malformed native tool inventory')
      const nativeNames=[]
      for(let i=0;i<listed.length;i++){
        const item=Object.getOwnPropertyDescriptor(listed,String(i))
        if(!item||!Object.hasOwn(item,'value')||!item.value||typeof item.value!=='object')throw new ServerActivationError('Malformed native tool inventory entry')
        let found=false
        for(const key of ['id','name']){
          const d=Object.getOwnPropertyDescriptor(item.value,key)
          if(!d)continue
          if(!Object.hasOwn(d,'value')||typeof d.value!=='string'||!d.value)throw new ServerActivationError('Malformed native tool identity')
          nativeNames.push(d.value);found=true
        }
        if(!found)throw new ServerActivationError('Native tool identity unavailable')
      }
      const targets=[],byURL=new Map()
      // Resolve the entire declared set before evaluating any target module.
      for(const target of config.targets){
        let url
        try{url=await resolveLegacyTarget(target.module,{baseDirectory:owner.directory,projectDirectory:owner.worktree})}
        catch(cause){throw new ServerActivationError('Target '+target.id+' cannot resolve '+target.module,cause)}
        assertActive()
        if(byURL.has(url))throw new ServerConfigurationError('Duplicate resolved target: '+target.id+' and '+byURL.get(url).id)
        const selected={...target,url};byURL.set(url,selected)
        targets.push(Object.hasOwn(target,'options')?[url,target.options]:url)
      }
      const observerTargets=[...byURL.values()].filter(target=>target.pendingPermissionObserver===true).map(target=>target.url)
      const bindings={
        toolExposure:config.toolExposure,nativeToolNames:[...new Set(nativeNames)],
        ...(observerTargets.length?{pendingPermissionObserver:{
          targets:Object.freeze(observerTargets),
          createMapper:(_plugin,isOpen)=>createPendingPermissionObserverMapper({isOpen,async checkPending(request,admitted){
            if(!admitted())return false
            if(!await sessionOwned(request.sessionID,admitted))return false
            const listed=await methods.find(x=>x.domain==='permission'&&x.key==='list').call({sessionID:request.sessionID})
            if(!admitted())return false
            assertActive()
            if(!Array.isArray(listed)||Reflect.ownKeys(listed).length!==listed.length+1)throw new ServerActivationError('Malformed pending permission inventory')
            const matches=[],seen=new Set()
            for(let i=0;i<listed.length;i++){
              const slot=Object.getOwnPropertyDescriptor(listed,String(i)),value=slot&&Object.hasOwn(slot,'value')?slot.value:undefined
              const id=value&&Object.getOwnPropertyDescriptor(value,'id'),session=value&&Object.getOwnPropertyDescriptor(value,'sessionID')
              if(!id||!session||!Object.hasOwn(id,'value')||!Object.hasOwn(session,'value')||typeof id.value!=='string'||seen.has(id.value)||session.value!==request.sessionID)throw new ServerActivationError('Malformed or foreign pending permission identity')
              seen.add(id.value);if(id.value===request.id)matches.push(value)
            }
            if(!matches.length)return false
            const current=snapshotPendingPermissionRequest(matches[0])
            assertActive()
            if(!isDeepStrictEqual(current,request))throw new ServerActivationError('Pending permission event does not match native request')
            return true
          }}),
          onError:error=>warning('V1_BRIDGE_PERMISSION_OBSERVER_ERROR',error),
        }}:{}),

        async makeInvocation(native){
          assertActive()
          const identity=snapshotPermissionContext(native)
          identity.signal.throwIfAborted()
          await sessionOwned(identity.sessionID)
          identity.signal.throwIfAborted()
          return {sessionID:identity.sessionID,messageID:identity.messageID,agent:identity.agent,
            directory:owner.directory,worktree:owner.worktree,abort:identity.signal,
            ...(config.metadata?{metadata:createToolMetadataBinding({profile:'live-json',progress:method({tool:native},'tool','progress').call})}:{})}
        },
        ...(config.system?{async mapSystemInput(event){
          if(typeof event?.sessionID!=='string'||!event.sessionID)throw new ServerActivationError('System context requires a sessionID')
          await sessionOwned(event.sessionID)
          // V2 Model.Ref is NOT V1 Model. No invented fields or misleading projection.
          return Object.freeze({sessionID:event.sessionID,get model(){throw new UnsupportedLegacyAPIError('experimental.chat.system.transform.model (session-text profile)')}})
        }}:{}),
        ...(config.events?{
          createEventMapper:plugin=>config.events==='session-lifecycle'?createV2027SessionLifecycleEventMapper({
            includeFailureIdle:true,
            isOpen:()=>state.phase==='initializing'||state.phase==='active',
            checkSession:async(id,admitted,nativeLocation)=>{
              if(nativeLocation&&(!samePath(nativeLocation.directory,owner.directory)||nativeLocation.workspaceID!==owner.workspaceID))throw new ServerActivationError('Native event location contradicts activation ownership')
              return Boolean(await sessionOwned(id,admitted))
            },
            ...(byURL.get(plugin.url)?.sessionCreated===true?{sessionCreated:{
              // The public Promise session.get encoder strips workspaceID.
              // Admit only workspace-free creation envelopes; the native
              // projector timestamp check below also excludes changed rows.
              accepts:({projectID,location})=>owner.workspaceID===undefined&&location.workspaceID===undefined&&
                projectID===owner.projectID&&samePath(location.directory,owner.directory),
              readSession:sessionOwned,
            }}:{}),
          }):createV2027AssistantEventMapper({onUnsupported:info=>warning('V1_BRIDGE_UNMAPPED_EVENT','Unmapped native event in terminal-assistant profile: '+info.type)}),
          onEventError:error=>warning('V1_BRIDGE_EVENT_ERROR',error),
        }:{}),
        ...(hasCommands?{commandEntries(plugin){
          const target=byURL.get(plugin.url)
          if(!target?.commands)throw new ServerConfigurationError('Target '+(target?.id??plugin.target)+' declares a command hook; explicit commands are required')
          return target.commands.map(name=>({name,description:'Legacy /'+name+' command',hook:plugin.hooks['command.execute.before']}))
        }}:{})
      }
      const options={
        targets,baseDirectory:owner.directory,bindings,
        async createInputResource(actual,imported){
          assertActive()
          if(actual!==ctx||!byURL.has(imported.url))throw new ServerActivationError('Unowned legacy input request')
          if(!config.logging)return createNativeLegacyInputResource(actual,{clientOptions:config.clientOptions??{}})
          const logger=createStderrLegacyLogger()
          try{return createCapabilityLegacyInputResource(actual,{
            clientOptions:config.clientOptions??{},
            logging:{owner:ownerOf(actual),async write(body,invocation){
              if(Object.hasOwn(body,'extra'))throw new UnsupportedLegacyAPIError('client.app.log.extra (stderr profile)')
              invocation.signal.throwIfAborted()
              await logger({body})
              invocation.signal.throwIfAborted()
              return {requestID:invocation.requestID,activationID:invocation.activationID,owner:invocation.owner,status:'written'}
            },dispose:()=>logger.dispose()}
          })}catch(error){
            try{await logger.dispose()}catch(cleanup){throw new AggregateError([error,cleanup],'Logging input construction and rollback failed')}
            throw error
          }
        },
        onActivated(_active,loaded){
          for(const plugin of loaded){
            const target=byURL.get(plugin.url)
            if(target.commands&&!plugin.hooks['command.execute.before'])throw new ServerConfigurationError('Target '+target.id+' configured commands without a legacy command hook')
            if(target.sessionCreated&&!plugin.hooks.event)throw new ServerConfigurationError('Target '+target.id+' opted in to sessionCreated without a legacy event hook')
          }
        }
      }
      // Server-only targets acquire no RPC/UI transport. Declared commands use
      // existing confirmed delivery, including pre-hook consumer readiness.
      const bridge=hasCommands?createRpcDeliveredNativeV2BridgeDefinition({...options,
        commandNames:config.targets.flatMap(t=>t.commands??[]),outputReceiptTimeoutMs:2000}):createNativeV2BridgeDefinition(options)
      close=await bridge.setup(ctx)
      assertActive();state.phase='active'
      let closing
      return ()=>{
        if(!closing){state.phase='disposing';closing=Promise.resolve().then(close).then(
          ()=>{state.phase='disposed';contexts.delete(ctx)},
          error=>{state.phase='quarantined';throw new ServerActivationError('Server cleanup failed',error)})}
        return closing
      }
    }catch(cause){
      if(close){
        state.phase='disposing'
        try{await close()}catch(cleanup){cause=new AggregateError([cause,cleanup],'Activation and rollback failed');cause.cleanupFailed=true}
      }
      if(cause?.cleanupFailed)state.phase='quarantined'
      else contexts.delete(ctx)
      throw new ServerActivationError('V1 bridge server activation failed',cause)
    }
  }})
}
export default createServerPlugin()
