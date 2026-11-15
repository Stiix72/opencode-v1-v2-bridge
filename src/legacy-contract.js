/**
 * Pure, host-independent legacy module classifier.
 * Does not import a package or execute plugin factories.
 * Never classify a native V2 definition as legacy.
 */
export function classifyPluginModule(namespace) {
  if (!namespace || (typeof namespace !== 'object' && typeof namespace !== 'function')) {
    return { kind: 'unsupported', reason: 'Module namespace missing' }
  }
  const entry = namespace.default ?? namespace
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' &&
      (typeof entry.setup === 'function' || typeof entry.effect === 'function')) {
    return { kind: 'native-v2', id: entry.id }
  }
  if (entry && typeof entry === 'object' && typeof entry.server === 'function') {
    return { kind: 'legacy-object', id: typeof entry.id === 'string' ? entry.id : undefined, factory: entry.server }
  }
  if (typeof entry === 'function') {
    return { kind: 'legacy-function', factory: entry }
  }
  return { kind: 'unsupported', reason: 'No supported legacy entry point' }
}

/** Validate the shape returned by a V1 factory, without running any hooks. */
export function inspectLegacyHooks(hooks, {pendingPermissionObserver=false}={}) {
  if(typeof pendingPermissionObserver!=='boolean')throw new TypeError('pendingPermissionObserver must be boolean')
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('Legacy factory must return a hook object')
  }
  const supported = ['tool', 'command.execute.before', 'experimental.chat.system.transform', 'event',
    'tool.execute.before', 'tool.execute.after', 'dispose', ...(pendingPermissionObserver?['permission.ask']:[])]
  const recognized = supported.filter(key => Object.hasOwn(hooks, key))
  for (const key of recognized) {
    const descriptor = Object.getOwnPropertyDescriptor(hooks,key)
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw new TypeError('Accessor legacy hook: '+key)
    const value = descriptor.value
    if (key === 'dispose' && value === undefined) continue
    if (key === 'tool') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('tool must be a registry object')
      for (const [name, definition] of Object.entries(value)) {
        if (!definition || typeof definition.execute !== 'function') throw new TypeError(`Invalid tool: ${name}`)
      }
    } else if (typeof value !== 'function') {
      throw new TypeError(`Hook ${key} must be a function`)
    }
  }
  return { recognized, unsupported: Object.keys(hooks).filter(key => !supported.includes(key)) }
}
