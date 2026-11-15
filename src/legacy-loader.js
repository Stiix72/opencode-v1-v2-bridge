/**
 * Independent legacy module loader. No OpenCode internals or installation changes.
 * Explicit targets only: the native V2 plugin list must NOT contain these targets.
 * Importing a module executes its top-level code, as with any JS module import.
 */
import { cloneFactoryOptions, snapshotLegacyTargets, legacyTargetName } from './legacy-factory-options.js'
import {snapshotPendingObserverTargets} from './pending-permission-observer.js'
import { resolveLegacyTarget } from './legacy-target-resolution.js'
import { classifyPluginModule, inspectLegacyHooks } from './legacy-contract.js'
import { legacyPluginOwner, disposeUnclaimedLegacyPlugins, settleLegacyCleanup, lifecycleTimeout } from './legacy-lifecycle.js'

export class LegacyLoadError extends Error {
  constructor(target, stage, cause) {
    super(`Legacy plugin ${JSON.stringify(target)} failed during ${stage}: ${cause?.message ?? String(cause)}`, { cause })
    this.name = 'LegacyLoadError'
    this.target = target
    this.stage = stage
  }
}

export { resolveLegacyTarget }

/**
 * Imports and validates only. The legacy factory is not executed here.
 * Rejecting native V2 and unsupported exports prevents accidental double loading.
 */
export async function importLegacyPlugin(target, options = {}) {
  let url
  try { url = await resolveLegacyTarget(target, options) }
  catch (error) { throw new LegacyLoadError(target, 'resolution', error) }
  let namespace
  try { namespace = await import(url) }
  catch (error) { throw new LegacyLoadError(target, 'import', error) }
  const classification = classifyPluginModule(namespace)
  if (classification.kind !== 'legacy-function' && classification.kind !== 'legacy-object') {
    throw new LegacyLoadError(target, 'classification', new TypeError(
      classification.kind === 'native-v2' ? 'Native V2 plugin must be loaded by OpenCode itself' : classification.reason
    ))
  }
  return { target, url, ...classification }
}

/**
 * Run the factory with a caller-supplied V1 PluginInput. This function is kept
 * separate from import so the adapter can construct a compatibility context.
 * Unsupported hooks are rejected by default, never silently discarded.
 */
export async function initializeLegacyPlugin(imported, legacyInput, { allowUnsupported = false, lifecycleTimeoutMs = 2000, factoryOptions, pendingPermissionObserver=false } = {}) {
  if (!imported || !['legacy-function', 'legacy-object'].includes(imported.kind) || typeof imported.factory !== 'function') {
    throw new TypeError('Expected a classified legacy plugin')
  }
  lifecycleTimeout(lifecycleTimeoutMs)
  let selectedOptions
  try{if(factoryOptions!==undefined)selectedOptions=cloneFactoryOptions(factoryOptions)}
  catch(cause){throw new LegacyLoadError(imported.target,'factory-options',cause)}
  let hooks
  try { hooks = await (selectedOptions===undefined?imported.factory(legacyInput):imported.factory(legacyInput,selectedOptions)) }
  catch (error) { throw new LegacyLoadError(imported.target, 'initialization', error) }
  const record = { ...imported, hooks }
  let owner
  try { owner = legacyPluginOwner(record) }
  catch (cause) { throw new LegacyLoadError(imported.target, 'validation', cause) }
  try {
    const inventory = inspectLegacyHooks(hooks,{pendingPermissionObserver})
    if (!allowUnsupported && inventory.unsupported.length) throw new TypeError('Unsupported hooks: '+inventory.unsupported.join(', '))
    record.inventory = inventory
    record.dispose = () => { if(owner.claimed)throw new TypeError('Plugin belongs to an activation; dispose the activation'); return disposeUnclaimedLegacyPlugins([record], {timeoutMs:lifecycleTimeoutMs}) }
    return record
  } catch (cause) {
    const failure = new LegacyLoadError(imported.target, 'validation', cause)
    try { await settleLegacyCleanup([()=>owner.disposeUnclaimed()], {timeoutMs:lifecycleTimeoutMs}) }
    catch (cleanup) { const error = new LegacyLoadError(imported.target, 'validation and cleanup', new AggregateError([failure,cleanup], 'Legacy validation and cleanup failed')); error.cleanupFailed = true; error.cleanupDone = cleanup.cleanupDone; throw error }
    throw failure
  }
}

/** Load several explicit targets without aborting on the first failure. */
export async function loadLegacyPlugins(targets, inputFactory, options = {}) {
  if (!Array.isArray(targets)) throw new TypeError('targets must be an array')
  if (typeof inputFactory !== 'function') throw new TypeError('inputFactory must be a function')
  if(Object.hasOwn(options,'factoryOptions'))throw new TypeError('Shared factoryOptions are unsupported; use per-target [target, options] entries')
  if(Object.hasOwn(options,'pendingPermissionObserver'))throw new TypeError('Use explicit per-target pendingPermissionObserverTargets')
  const observerTargets=snapshotPendingObserverTargets(options.pendingPermissionObserverTargets)
  const selectedTargets=snapshotLegacyTargets(targets)
  const loaded = []
  const failures = []
  const seen = new Set()
  for (const entry of selectedTargets) {
    const target=legacyTargetName(entry)
    try {
      const imported = await importLegacyPlugin(target, options)
      if (seen.has(imported.url)) throw new LegacyLoadError(target, 'deduplication', new TypeError('Duplicate resolved entrypoint'))
      seen.add(imported.url)
      loaded.push(await initializeLegacyPlugin(imported, await inputFactory(imported), {...options,pendingPermissionObserver:observerTargets.includes(imported.url),factoryOptions:typeof entry==='string'?undefined:entry[1]}))
    } catch (error) {
      failures.push({ target, error })
    }
  }
  return { loaded, failures, dispose: () => disposeUnclaimedLegacyPlugins(loaded, {timeoutMs:options.lifecycleTimeoutMs??2000}) }
}
