/** Explicit V1 loader + supported V2 setup lifetime. Never installs packages. */
import {snapshotLegacyTargets,legacyTargetName,applyNativeFactoryOptions} from './legacy-factory-options.js'
import {createNativeLegacyInputResource} from './native-plugin-input.js'
import {capabilityInputRevocation} from './legacy-client-capabilities.js'
import {loadLegacyPlugins} from './legacy-loader.js'
import {createLegacyInput} from './legacy-context.js'
import {planV2LegacyBridge,activateV2LegacyBridge} from './v2-bridge-composition.js'
import {onceCleanup,settleLegacyCleanup,claimLegacyResource,lifecycleTimeout,LegacyLifecycleError} from './legacy-lifecycle.js'
export class V2PluginEntrypointError extends Error {
  constructor(message,cause){super(message,{cause});this.name='V2PluginEntrypointError'}
}
const factoryClaims=new WeakSet()
export function createV2BridgeDefinition({id='opencode-v1-bridge',targets,baseDirectory,
  makeLegacyInput,legacyClient,createInputResource,bindings,createBindings,onActivated,lifecycleTimeoutMs}={}) {
  if(typeof id!=='string'||!id.trim())throw new TypeError('V2 bridge id must be nonempty')
  const selectedTargets=snapshotLegacyTargets(targets)
  if(!selectedTargets.length)throw new TypeError('targets must be a nonempty list of explicit legacy entrypoints')
  if(new Set(selectedTargets.map(legacyTargetName)).size!==selectedTargets.length)throw new TypeError('Duplicate legacy targets')
  if(makeLegacyInput!==undefined&&typeof makeLegacyInput!=='function')throw new TypeError('makeLegacyInput must be a function')
  if(legacyClient!==undefined&&typeof legacyClient!=='function')throw new TypeError('legacyClient must be a function')
  if(createInputResource!==undefined&&typeof createInputResource!=='function')throw new TypeError('createInputResource must be a function')
  if([makeLegacyInput,legacyClient,createInputResource].filter(Boolean).length!==1)throw new TypeError('Exactly one real legacy input provider is required')
  if(createBindings!==undefined&&(typeof createBindings!=='function'||bindings!==undefined))throw new TypeError('Choose explicit bindings or a createBindings factory')
  if(createBindings===undefined&&(!bindings||typeof bindings!=='object'))throw new TypeError('Explicit V2 bindings are required')
  if(onActivated!==undefined&&typeof onActivated!=='function')throw new TypeError('onActivated must be a function')
  if(lifecycleTimeoutMs!==undefined)lifecycleTimeout(lifecycleTimeoutMs)
  const contexts=new WeakMap()
  return Object.freeze({id,async setup(ctx){
    if(!ctx||typeof ctx!=='object')throw new V2PluginEntrypointError('V2 context object required')
    if(contexts.has(ctx))throw new V2PluginEntrypointError('Bridge setup refused: context activation is active, initializing, disposing or quarantined')
    const state={phase:'initializing'};contexts.set(ctx,state)
    let loaded,active,ownedBindings=bindings,bindingCleanup,transferred=false
    const inputCleanups=[],inputRevocations=[]
    const revokeInputs=()=>{const errors=[];for(const stop of inputRevocations)try{stop()}catch(error){errors.push(error)}if(errors.length)throw new AggregateError(errors,'PluginInput revocation failed')}
    const resourceCleanup=onceCleanup(async()=>{
      const results=await Promise.allSettled(inputCleanups.slice().reverse().map(fn=>Promise.resolve().then(fn)))
      if(bindingCleanup)results.push(await Promise.resolve().then(bindingCleanup).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason})))
      const failures=results.filter(x=>x.status==='rejected').map(x=>x.reason)
      if(failures.length)throw new AggregateError(failures,'PluginInput and binding resource cleanup failed')
    })
    let timeoutMs=2000
    const cleanupBeforeActivation=()=>{
      const jobs=[]
      try{revokeInputs()}catch(error){jobs.push(Promise.reject(error))}
      if(loaded)jobs.push(loaded.dispose())
      if(ownedBindings?.permissionBinding){
        try{jobs.push(claimLegacyResource(ownedBindings.permissionBinding)())}catch(error){jobs.push(Promise.reject(error))}
      }
      // Failed initialization can have a timed-out disposer still in flight.
      const pending=loaded?.failures.map(x=>x.error.cleanupDone).filter(Boolean)??[]
      const tail=Promise.allSettled([...jobs.map(p=>p.cleanupDone??p),...pending]).then(()=>resourceCleanup?.())
      return settleLegacyCleanup([...jobs,tail].map(p=>()=>p),{timeoutMs,label:'Legacy setup cleanup failed'})
    }
    try{
      const activationTargets=applyNativeFactoryOptions(selectedTargets,ctx.options)
      timeoutMs=lifecycleTimeout(lifecycleTimeoutMs??bindings?.lifecycleTimeoutMs)
      if(createBindings){
        const produced=await createBindings(ctx)
        if(!produced||typeof produced!=='object')throw new TypeError('createBindings must return {bindings, dispose?}')
        if(factoryClaims.has(produced))throw new LegacyLifecycleError('ownership','createBindings must return a fresh activation resource record')
        factoryClaims.add(produced)
        const descriptor=Object.getOwnPropertyDescriptor(produced,'dispose')
        if(descriptor&&!Object.hasOwn(descriptor,'value'))throw new TypeError('Activation resource dispose must not be an accessor')
        if(descriptor?.value!==undefined)bindingCleanup=claimLegacyResource(produced)
        ownedBindings=produced.bindings
        if(!ownedBindings||typeof ownedBindings!=='object')throw new TypeError('createBindings result requires bindings')
      }
      timeoutMs=lifecycleTimeout(lifecycleTimeoutMs??ownedBindings.lifecycleTimeoutMs)
      const activationBindings={...ownedBindings,lifecycleTimeoutMs:timeoutMs}
      loaded=await loadLegacyPlugins(activationTargets,async imported=>{
        if(createInputResource){
          const produced=await createInputResource(ctx,imported)
          if(!produced||typeof produced!=='object')throw new TypeError('createInputResource requires an owned input/dispose record')
          const d=Object.getOwnPropertyDescriptor(produced,'dispose'),input=Object.getOwnPropertyDescriptor(produced,'input')
          if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function')throw new TypeError('Input resource dispose must be a function data property')
          inputCleanups.push(claimLegacyResource(produced))
          const revocation=capabilityInputRevocation(produced)
          if(revocation)inputRevocations.push(revocation)
          if(!input||!Object.hasOwn(input,'value')||!input.value||typeof input.value!=='object')throw new TypeError('Input resource requires an input object data property')
          return input.value
        }
        if(makeLegacyInput)return makeLegacyInput(ctx,imported)
        const client=await legacyClient(ctx,imported)
        return createLegacyInput({directory:ctx.directory,worktree:ctx.worktree??ctx.directory,...client})
      },{baseDirectory,lifecycleTimeoutMs:timeoutMs,pendingPermissionObserverTargets:activationBindings.pendingPermissionObserver?.targets})
      if(loaded.failures.length)throw new V2PluginEntrypointError(
        `Refusing partial activation: ${loaded.failures.length} of ${selectedTargets.length} legacy plugins failed`,
        new AggregateError(loaded.failures.map(x=>x.error),'Legacy plugin failures'))
      const plan=planV2LegacyBridge(ctx,loaded.loaded,activationBindings)
      transferred=true
      active=await activateV2LegacyBridge(plan,{stopResources:[revokeInputs],cleanupResources:resourceCleanup?[resourceCleanup]:[]})
      if(onActivated)await onActivated(active,loaded.loaded)
      if(active.disposed)throw new V2PluginEntrypointError('Bridge disposed during activation callback')
      state.phase='active'
      const dispose=active.dispose
      let stopping,cleanupStarted=false
      const finishDispose=onceCleanup(async()=>{
        try{await stopping;state.phase='disposed';contexts.delete(ctx)}
        catch(error){state.phase='quarantined';throw error}
      })
      active.dispose=()=>{
        if(!cleanupStarted){
          cleanupStarted=true;state.phase='disposing'
          try{stopping=dispose()}catch(error){stopping=Promise.reject(error)}
        }
        return finishDispose()
      }
      return active
    }catch(cause){
      let cleanupError
      try{
        if(active)await active.dispose()
        else if(!transferred)await cleanupBeforeActivation()
      }catch(error){cleanupError=error}
      const cleanupFailed=!!(cleanupError||cause.cleanupFailed||loaded?.failures.some(x=>x.error.cleanupFailed))
      if(cleanupFailed){state.phase='quarantined'}else{state.phase='failed';contexts.delete(ctx)}
      const failure=cleanupError
        ?new V2PluginEntrypointError('Legacy V2 bridge activation and cleanup failed',new AggregateError([cause,cleanupError],'Activation and cleanup failed'))
        :cause instanceof V2PluginEntrypointError?cause:new V2PluginEntrypointError('Legacy V2 bridge activation failed',cause)
      // Preserve the internal quarantine boundary through the Promise wrapper.
      if(cleanupFailed)failure.cleanupFailed=true
      throw failure
    }
  }})
}
/** Exact v2.0.27 Promise setup returns Cleanup|void. The host alone decides
 * when a new activation/fallback runs; this factory never retries itself. */
export function createNativeV2BridgeDefinition(options={}) {
  const {legacyClient,makeLegacyInput,createInputResource}=options
  // The native default uses only supported Location/Promise domains. Missing V1 capabilities reject.
  const defaults=legacyClient===undefined&&makeLegacyInput===undefined&&createInputResource===undefined
    ?{createInputResource:ctx=>createNativeLegacyInputResource(ctx)}:{}

  const legacy=createV2BridgeDefinition({...options,...defaults,...(legacyClient&&!makeLegacyInput?{
    makeLegacyInput:async(ctx,imported)=>{
      const directory=ctx?.location?.directory
      if(typeof directory!=='string'||!directory)throw new TypeError('V2 location.directory is required')
      const client=await legacyClient(ctx,imported)
      return createLegacyInput({directory,worktree:ctx.location.project?.directory??directory,...client})
    },legacyClient:undefined,
  }:{})})
  return Object.freeze({id:legacy.id,async setup(ctx){
    try{
      if(!ctx||typeof ctx.location?.directory!=='string'||!ctx.location.directory)throw new TypeError('Native V2 context.location.directory is required')
      const active=await legacy.setup(ctx)
      return active.dispose
    }catch(cause){
      const failure=new V2PluginEntrypointError('Native V2 setup failed',cause)
      if(cause?.cleanupFailed)failure.cleanupFailed=true
      throw failure
    }
  }})
}