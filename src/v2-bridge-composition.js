import { legacyPluginOwner, claimLegacyResource, onceCleanup, settleLegacyCleanup, lifecycleTimeout } from './legacy-lifecycle.js'
import { bindCommandOutputReadiness, commandOutputReadiness } from './legacy-command-bridge.js'
import { registerLegacyToolHooks } from './legacy-tool-hooks.js'
/**
 * Offline composition boundary for a future native V2 plugin setup(ctx).
 * This is intentionally NOT a plugin entrypoint: host bindings and exact
 * OpenCode 2.0.27 signatures have not been verified.
 *
 * All required host capabilities are checked before any registration.
 * Registration itself is not transactional; V2 APIs provide no rollback here.
 */
import { integrateLegacyTools } from './v2-tool-integration.js'
import { prepareV2LegacyCommands, registerPreparedV2LegacyCommands } from './v2-command-registration.js'
import { registerLegacySystemPrompt } from './legacy-system-prompt.js'
import { registerLegacyEvents } from './legacy-event-bridge.js'
import {snapshotPendingObserverTargets} from './pending-permission-observer.js'

export class V2BridgeCompositionError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2BridgeCompositionError'
  }
}

const valid = (value) => typeof value === 'function'

function rejectAccessors(object, label) {
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && !Object.hasOwn(descriptor, 'value')) {
      throw new V2BridgeCompositionError(`${label}: accessor property is not allowed`)
    }
  }
}



function observerPolicy(value){
  if(value===undefined)return null
  if(!value||typeof value!=='object'||Array.isArray(value))throw new V2BridgeCompositionError('Invalid pending-permission observer policy')
  rejectAccessors(value,'Pending-permission observer policy')
  if(Object.keys(value).some(key=>!['targets','createMapper','onError'].includes(key))||!valid(value.createMapper)||!valid(value.onError))throw new V2BridgeCompositionError('Observer policy requires explicit targets, mapper and error reporter')
  const targets=snapshotPendingObserverTargets(value.targets)
  if(!targets.length)throw new V2BridgeCompositionError('Observer policy requires selected targets')
  return Object.freeze({targets,createMapper:value.createMapper,onError:value.onError})
}
/**
 * `plugins`: initialized V1 plugin records, not raw package names.
 * `bindings`: explicit host-specific adapters; absent adapters cause refusal.
 * No legacy callbacks execute during preflight.
 */
export function planV2LegacyBridge(ctx, plugins, bindings = {}) {
  if (!Array.isArray(plugins)) throw new TypeError('plugins must be an array')
  lifecycleTimeout(bindings.lifecycleTimeoutMs)
  const features = { tools: [], commands: [], system: [], events: [], toolHooks: [] }
  const permissionObserverPolicy=observerPolicy(bindings.pendingPermissionObserver),permissionObservers=[]
  for (const [index, plugin] of plugins.entries()) {
    if (plugin && typeof plugin === 'object') rejectAccessors(plugin, `Plugin ${index}`)
    if (!plugin || !plugin.hooks || typeof plugin.hooks !== 'object') {
      throw new V2BridgeCompositionError(`Invalid initialized plugin at index ${index}`)
    }
    const id = plugin.id ?? plugin.target ?? `legacy-${index}`
    const hooks = plugin.hooks
    rejectAccessors(hooks, `Plugin ${id} hooks`)
    // Capture/validate disposal descriptors before reading optional inherited hooks.
    legacyPluginOwner(plugin)
    const supported = new Set(['tool', 'command.execute.before', 'experimental.chat.system.transform', 'event', 'tool.execute.before', 'tool.execute.after', 'dispose', ...(permissionObserverPolicy?.targets.includes(plugin.url)?['permission.ask']:[])])
    const unsupported = Object.keys(hooks).filter(key => !supported.has(key))
    if (unsupported.length) {
      throw new V2BridgeCompositionError(`Plugin ${id}: unimplemented hooks: ${unsupported.join(', ')}`)
    }
    // Validate every supported hook before the first host registration. The
    // legacy loader validates factory output, but callers can also supply
    // initialized records directly or mutate them after loading.
    if (hooks.tool !== undefined) {
      if (!hooks.tool || typeof hooks.tool !== 'object' || Array.isArray(hooks.tool)) {
        throw new V2BridgeCompositionError(`Plugin ${id}: tool registry must be an object`)
      }
      rejectAccessors(hooks.tool, `Plugin ${id} tool registry`)
      for (const [name, definition] of Object.entries(hooks.tool)) {
        if (definition && typeof definition === 'object') rejectAccessors(definition, `Plugin ${id} tool ${name}`)
        if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
          throw new V2BridgeCompositionError(`Plugin ${id}: invalid tool definition ${name}`)
        }
      }
    }
    for (const key of ['command.execute.before', 'experimental.chat.system.transform', 'event', 'tool.execute.before', 'tool.execute.after', 'dispose', 'permission.ask']) {
      if (hooks[key] !== undefined && typeof hooks[key] !== 'function') {
        throw new V2BridgeCompositionError(`Plugin ${id}: ${key} must be a function`)
      }
    }
    if(hooks['permission.ask']!==undefined)permissionObservers.push(plugin)
    if (hooks['tool.execute.before'] !== undefined || hooks['tool.execute.after'] !== undefined) features.toolHooks.push(plugin)
    if (hooks.tool !== undefined) features.tools.push(plugin)
    if (hooks['command.execute.before'] !== undefined) features.commands.push(plugin)
    if (hooks['experimental.chat.system.transform'] !== undefined) features.system.push(plugin)
    if (hooks.event !== undefined) features.events.push(plugin)
  }
  if(permissionObserverPolicy&&permissionObserverPolicy.targets.some(url=>!permissionObservers.some(plugin=>plugin.url===url)))throw new V2BridgeCompositionError('Selected pending-permission observer target lacks a permission.ask hook')
  if(permissionObservers.length&&!valid(ctx?.event?.subscribe))throw new V2BridgeCompositionError('Pending-permission observers require native event.subscribe')
  if (features.toolHooks.length && (!valid(ctx?.tool?.hook) || !valid(ctx?.tool?.list))) throw new V2BridgeCompositionError('Tool hooks require native tool.hook and tool.list')
  if (features.tools.length && (!valid(ctx?.tool?.transform) || !valid(bindings.makeInvocation))) {
    throw new V2BridgeCompositionError('Tools require V2 tool.transform and an explicit makeInvocation binding')
  }
  if (bindings.permissionBinding !== undefined && (typeof bindings.permissionBinding?.ask !== 'function' || typeof bindings.permissionBinding?.dispose !== 'function' || bindings.makeToolContext !== undefined)) {
    throw new V2BridgeCompositionError('permissionBinding requires exclusive ask/dispose ownership; use makeInvocation for paths')
  }
  if (features.commands.length && (!valid(ctx?.command?.transform) || !valid(bindings.decodeCommand) || !valid(bindings.deliverCommand) || !valid(bindings.commandEntries))) {
    throw new V2BridgeCompositionError('Commands require command.transform, commandEntries, decodeCommand, and deliverCommand bindings')
  }
  if (features.system.length && (!valid(ctx?.session?.hook) || !valid(bindings.mapSystemInput))) {
    throw new V2BridgeCompositionError('System prompts require session.hook and mapSystemInput binding')
  }
  if (features.events.length && (!valid(ctx?.event?.subscribe) || (!valid(bindings.mapEvent) && !valid(bindings.createEventMapper)))) {
    throw new V2BridgeCompositionError('Events require event.subscribe and mapEvent or createEventMapper binding')
  }
  if (features.events.length && bindings.createEventMapper !== undefined &&
      (!valid(bindings.createEventMapper) || bindings.mapEvent !== undefined)) {
    throw new V2BridgeCompositionError('Choose either mapEvent or a createEventMapper factory')
  }
  if (features.events.length && valid(bindings.createEventMapper) && !valid(bindings.onEventError)) {
    throw new V2BridgeCompositionError('Stateful event mapping requires an explicit onEventError reporter')
  }
  // A plan is a preflight snapshot, not a promise that caller-owned plugin
  // records will remain unchanged. Capture each validated registry and hook
  // identity; otherwise a mutation between planning and activation can bypass
  // validation and register an unreviewed callback.
  const signatures = plugins.map(plugin => ({
    plugin,
    hooks: plugin.hooks,
    entries: Object.entries(plugin.hooks).map(([key, value]) => ({
      key, value,
      tools: key === 'tool' ? Object.entries(value).map(([name, definition]) => ({
        name, definition, execute: definition.execute, args: definition.args,
      })) : null,
    })),
  }))
  for (const group of Object.values(features)) Object.freeze(group)
  return Object.freeze({ ...(permissionObserverPolicy?{permissionObserverPolicy,permissionObservers:Object.freeze(permissionObservers)}:{}),features: Object.freeze(features), ctx, bindings, signatures, plugins: Object.freeze([...plugins]), pluginOwners: Object.freeze(plugins.map(plugin=>Object.freeze({plugin,owner:legacyPluginOwner(plugin)}))) })
}

/**
 * Activate a preflighted plan. Any failure is surfaced. There is no claim of
 * atomic registration: if a later host call fails, earlier host registrations
 * may remain. Event subscriptions are started last and cleaned up on failure.
 */
export async function activateV2LegacyBridge(plan, { cleanupResources = [], stopResources = [] } = {}) {
  if (!plan || !plan.features || !plan.ctx || !plan.bindings) {
    throw new V2BridgeCompositionError('Expected a preflighted bridge plan')
  }
  const { features, ctx, bindings } = plan
  const assertSnapshotUnchanged = () => {
    if (Array.isArray(plan.signatures)) {
    for (const { plugin, hooks, entries } of plan.signatures) {
      rejectAccessors(plugin, 'Legacy plugin after preflight')
      rejectAccessors(hooks, 'Legacy hooks after preflight')
      if (plugin.hooks !== hooks || Object.keys(hooks).length !== entries.length) {
        throw new V2BridgeCompositionError('Legacy plugin hooks changed after preflight; replan required')
      }
      for (const { key, value, tools } of entries) {
        if (!Object.hasOwn(hooks, key) || hooks[key] !== value) {
          throw new V2BridgeCompositionError('Legacy plugin hook changed after preflight; replan required')
        }
        if (tools) {
          rejectAccessors(value, 'Legacy tool registry after preflight')
          for (const { definition } of tools) rejectAccessors(definition, 'Legacy tool definition after preflight')
          if (Object.keys(value).length !== tools.length || tools.some(({ name, definition, execute, args }) =>
            !Object.hasOwn(value, name) || value[name] !== definition || definition.execute !== execute || definition.args !== args)) {
            throw new V2BridgeCompositionError('Legacy tool registry changed after preflight; replan required')
          }
        }
      }
    }
    }
  }
  const result = { tools: null, commands: [], system: [], events: [], toolHooks: null, dispose: undefined }
  const owners = new Map(), registrations = [], dependencies = new Map(), timeoutMs = lifecycleTimeout(bindings.lifecycleTimeoutMs)
  let closing, eventAdmissionOpen = true
  const own = (handle,label,plugin) => {
    if(typeof handle?.dispose!=='function')throw new V2BridgeCompositionError(label+' did not provide a disposable registration')
    let actual
    const dispose=onceCleanup(()=>{actual=handle.dispose();return actual})
    const owned={...handle,dispose}
    registrations.push(owned)
    if(plugin){
      const waiting=dependencies.get(plugin)??[]
      waiting.push(async()=>{try{await dispose()}finally{await actual?.cleanupDone}})
      dependencies.set(plugin,waiting)
    }
    return owned
  }
  const cleanup = () => {
    if(closing)return closing
    // Close event admission before invalidating activation capabilities. The
    // subscription owns and drains callbacks already entered until its actual
    // cleanup completes; queued events cannot enter either mapper or V1 hook.
    eventAdmissionOpen = false
    for(const owner of owners.values())owner.lifetime.stop()
    result.disposed=true
    // All independent native stops begin before legacy finalizers. A broken
    // stop/finalizer cannot prevent independent attempts. Only dependent
    // factory resources wait for all actual operations/cleanup to finish.
    const stopJobs=stopResources.map(stop=>{try{return Promise.resolve(stop())}catch(error){return Promise.reject(error)}}).concat(registrations.slice().reverse().map(handle=>Promise.resolve().then(()=>handle.dispose())))
    const ownerJobs=[...owners.entries()].reverse().map(([plugin,owner])=>Promise.resolve().then(async()=>{
      await Promise.allSettled((dependencies.get(plugin)??[]).map(stop=>stop()))
      await owner.close()
    }))
    const first=[...stopJobs,...ownerJobs]
    const tail=Promise.allSettled(first).then(async()=>{
      const outcomes=await Promise.allSettled(cleanupResources.slice().reverse().map(fn=>Promise.resolve().then(fn)))
      const errors=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason)
      if(errors.length)throw new AggregateError(errors,'Activation resource cleanup failed')
    })
    closing=settleLegacyCleanup([...first,tail].map(job=>()=>job),{timeoutMs,label:'Legacy bridge cleanup failed'})
    return closing
  }
  result.dispose=cleanup
  const wrap = (plugin,fn,receiver=plugin.hooks,options) => owners.get(plugin).lifetime.wrap(fn,receiver,options)
  const scopedToolContext = () => {
    const byName=new Map()
    for(const plugin of features.tools)for(const name of Object.keys(plugin.hooks.tool))if(!byName.has(name))byName.set(name,plugin)
    return {tool:{...ctx.tool,transform:callback=>ctx.tool.transform(editor=>callback({...editor,add:definition=>{
      const plugin=byName.get(definition.name)
      if(!plugin)throw new V2BridgeCompositionError('Missing legacy tool resource owner')
      editor.add({...definition,execute:wrap(plugin,definition.execute,definition)})
    }}))}}
  }
  try {
    const claimErrors=[]
    for(const {plugin,owner} of plan.pluginOwners){
      try { owners.set(plugin,owner.claim()) } catch(error) { claimErrors.push(error) }
    }
    if(bindings.permissionBinding) {
      try { registrations.push({dispose:claimLegacyResource(bindings.permissionBinding)}) } catch(error) { claimErrors.push(error) }
    }
    if(claimErrors.length)throw new AggregateError(claimErrors,'Legacy activation ownership failed')
    assertSnapshotUnchanged()
    // Stage every legacy command before touching ANY host registration.
    // Detect collisions across distinct plugins, not just within one plugin.
    const allEntries = []
    const commandOwners = new Map()
    for (const plugin of features.commands) {
      const entries = await bindings.commandEntries(plugin)
      if (!Array.isArray(entries) || entries.some(entry => entry?.hook !== plugin.hooks['command.execute.before'])) {
        throw new V2BridgeCompositionError('commandEntries must return entries bound to the original legacy command hook')
      }
      if (entries.length === 0) {
        throw new V2BridgeCompositionError('commandEntries returned no commands for a legacy command hook')
      }
      for(const entry of entries){if(!commandOwners.has(entry.name))commandOwners.set(entry.name,plugin)}
      allEntries.push(...entries.map(entry=>({...entry,hook:wrap(plugin,entry.hook)})))
      // An async commandEntries binding can mutate a validated plugin.
      assertSnapshotUnchanged()
    }
    assertSnapshotUnchanged()
    const deliverCommand = (payload, ...evidence) => wrap(commandOwners.get(payload.command),bindings.deliverCommand,bindings)(payload, ...evidence)
    const requireReady = commandOutputReadiness(bindings.deliverCommand)
    if (requireReady) bindCommandOutputReadiness(deliverCommand, input =>
      wrap(commandOwners.get(input.command),requireReady,bindings)(input))
    const preparedCommands = allEntries.length ? prepareV2LegacyCommands(allEntries, {
      decode: bindings.decodeCommand, deliver: deliverCommand,
    }) : []
    for(const entry of preparedCommands){entry.execute=wrap(commandOwners.get(entry.name),entry.execute,entry)}
    if (features.tools.length) {
      result.tools = await integrateLegacyTools(scopedToolContext(), features.tools, {
        makeInvocation: bindings.makeInvocation,
        makeContext: bindings.makeToolContext,
        nativeNames: bindings.nativeToolNames ?? [],
        toolExposure: bindings.toolExposure,
        permissionBinding: bindings.permissionBinding,
      })
      if (result.tools.registered) {
        result.tools.registration=own(result.tools.registration,'V2 tool transform')
      }
    }
    if (features.toolHooks.length) {
      assertSnapshotUnchanged()
      const guarded=features.toolHooks.map(plugin=>({ ...plugin,hooks:Object.fromEntries(Object.entries(plugin.hooks).map(([key,value])=>[key,key==='tool.execute.before'||key==='tool.execute.after'?wrap(plugin,value):value])) }))
      result.toolHooks = own(await registerLegacyToolHooks(ctx, guarded),'V2 tool hooks')
    }
    // Host transforms and tool preparation may yield or invoke caller code.
    // Never proceed to the next registration using stale validated hooks.
    assertSnapshotUnchanged()
    if (preparedCommands.length) {
      const registration = own(await registerPreparedV2LegacyCommands(ctx.command, preparedCommands),'V2 command transform')
      result.commands.push(registration)
    }
    assertSnapshotUnchanged()
    for (const plugin of features.system) {
      assertSnapshotUnchanged()
      const owner=owners.get(plugin)
      const scoped={session:{hook:(name,callback)=>ctx.session.hook(name,owner.lifetime.wrap(callback))}}
      const registration = own(await registerLegacySystemPrompt(scoped, wrap(plugin,plugin.hooks['experimental.chat.system.transform']), {
        mapInput: event => owner.lifetime.run(()=>bindings.mapSystemInput(event, plugin)),
        assertActive: owner.lifetime.assertActive,
      }),'V2 session hook')
      result.system.push(registration)
    }
    assertSnapshotUnchanged()
    for (const plugin of features.events) {
      assertSnapshotUnchanged()
      // Stateful translators must be independent per plugin/subscription.
      const mapper = bindings.createEventMapper?.(plugin)
      if (bindings.createEventMapper && (typeof mapper?.mapEvent !== 'function' || typeof mapper?.dispose !== 'function')) {
        // Even invalid factory output may have acquired a resource. Transfer its
        // disclosed cleanup before failing; rollback must await/report it.
        if (typeof mapper?.dispose === 'function') own({dispose:()=>mapper.dispose()},'Invalid event mapper cleanup',plugin)
        throw new V2BridgeCompositionError('createEventMapper must return mapEvent and synchronous dispose')
      }
      let mapperDisposed = false
      const disposeMapper = mapper ? () => { if (!mapperDisposed) { mapperDisposed = true; return mapper.dispose() } } : undefined
      const eventHooks = plugin.hooks, eventHandler = eventHooks.event
      let subscription
      try {
        // Event callbacks are owned by this subscription, not by a second
        // deferred lifetime job. Its disposal tracks in-flight mapper/handler
        // promises and is a dependency of this plugin's finalizer.
        subscription = await registerLegacyEvents(ctx, input => {
          if (!eventAdmissionOpen) return
          owners.get(plugin).lifetime.assertActive()
          return Reflect.apply(eventHandler, eventHooks, [input])
        }, {
          mapEvent: event => {
            if (!eventAdmissionOpen) return null
            owners.get(plugin).lifetime.assertActive()
            return mapper ? mapper.mapEvent(event) : bindings.mapEvent(event, plugin)
          },
          disposeMapper,
          onError: bindings.onEventError,
        })
      } catch (error) {
        if(error.cleanupDone)own({dispose:()=>error.cleanupDone},'Incomplete event setup cleanup',plugin)
        try { disposeMapper?.() }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Event registration and mapper cleanup failed') }
        throw error
      }
      result.events.push(own(subscription,'V2 event subscription',plugin))
    }

    for(const plugin of plan.permissionObservers??[]){
      assertSnapshotUnchanged()
      const policy=plan.permissionObserverPolicy,owner=owners.get(plugin),isOpen=()=>eventAdmissionOpen&&!owner.lifetime.stopped
      const mapper=policy.createMapper(plugin,isOpen)
      if(typeof mapper?.mapEvent!=='function'||typeof mapper?.dispose!=='function'){
        if(typeof mapper?.dispose==='function')own({dispose:()=>mapper.dispose()},'Invalid permission observer mapper',plugin)
        throw new V2BridgeCompositionError('Permission observer mapper requires mapEvent and synchronous dispose')
      }
      let mapperDisposed=false
      const disposeMapper=()=>{if(!mapperDisposed){mapperDisposed=true;return mapper.dispose()}}
      const hooks=plugin.hooks,handler=hooks['permission.ask']
      let subscription
      try{
        subscription=await registerLegacyEvents(ctx,async({event})=>{
          const observation=event.properties
          if(!isOpen()){observation.revoke();return}
          owner.lifetime.assertActive()
          try{await Reflect.apply(handler,hooks,[observation.input,observation.output])}
          finally{observation.revoke()}
        },{
          mapEvent:event=>{if(!isOpen())return null;owner.lifetime.assertActive();return mapper.mapEvent(event)},
          disposeMapper,onError:policy.onError,disposeTimeoutMs:timeoutMs,
        })
      }catch(error){
        if(error.cleanupDone)own({dispose:()=>error.cleanupDone},'Incomplete permission observer cleanup',plugin)
        try{disposeMapper()}catch(cleanupError){throw new AggregateError([error,cleanupError],'Permission observer setup and cleanup failed')}
        throw error
      }
      result.permissionObservers??=[]
      result.permissionObservers.push(own(subscription,'Pending-permission observer subscription',plugin))
    }
    assertSnapshotUnchanged()
    return result
  } catch (cause) {
    try { await cleanup() }
    catch (cleanupError) {
      const failure = new V2BridgeCompositionError('Legacy bridge activation and rollback both failed', new AggregateError([cause, cleanupError]))
      failure.cleanupFailed = true
      throw failure
    }
    throw new V2BridgeCompositionError('Legacy bridge activation failed: '+cause.message, cause)
  }
}
