/**
 * Compose the existing offline stages into one V2 Promise-plugin registration
 * boundary. The caller owns the V2 ctx and the legacy plugin instances.
 * This does not import or modify OpenCode and does not load plugins by itself.
 */
import { legacyPluginOwner } from './legacy-lifecycle.js'
import { prepareZodV3LegacyTools } from './zod-v3-tool-pipeline.js'
import { registerV2ToolTransform, assertV2ToolAcceptance } from './v2-tool-registration.js'

export class LegacyToolIntegrationError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'LegacyToolIntegrationError'
  }
}

/**
 * Fail closed by default: partial activation would make a plugin look healthy
 * while some of its tools are unavailable. A diagnostic caller may explicitly
 * opt into partial registration.
 */
export async function integrateLegacyTools(ctx, plugins, {
  makeInvocation,
  makeContext,
  nativeNames = [],
  allowPartial = false,
  toolExposure = 'direct',
  permissionBinding,
} = {}) {
  const own = (object, key) => {
    if (!object || typeof object !== 'object') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new LegacyToolIntegrationError('V2 tool capability must be an own data property: ' + key)
    return descriptor?.value
  }
  const tool = own(ctx, 'tool'), transform = own(tool, 'transform'), list = own(tool, 'list')
  if (typeof transform !== 'function') throw new LegacyToolIntegrationError('V2 context is missing tool.transform')
  if (typeof list !== 'function') throw new LegacyToolIntegrationError('V2 context is missing tool.list for acceptance verification')
  const owners = plugins.map(plugin => legacyPluginOwner(plugin))
  const assertActive = () => {
    if (own(ctx, 'tool') !== tool || own(tool, 'transform') !== transform || own(tool, 'list') !== list) {
      throw new LegacyToolIntegrationError('V2 tool capability ownership changed during registration acceptance')
    }
    for (const owner of owners) owner.lifetime.assertActive()
  }
  assertActive()
  const { snapshot, prepared } = await prepareZodV3LegacyTools(plugins, {
    makeInvocation,
    makeContext,
    nativeNames,
    toolExposure,
    permissionBinding,
  })
  if (snapshot.failures.length && !allowPartial) {
    throw new LegacyToolIntegrationError(
      `Refusing partial legacy tool activation (${snapshot.failures.length} plugin failure(s))`,
      snapshot.failures[0].error,
    )
  }
  assertActive()
  if (!prepared.length) return { snapshot, prepared, registered: false }
  const registration = await registerV2ToolTransform(tool, prepared, { assertActive })
  try {
    assertActive()
    if (typeof registration?.dispose !== 'function') throw new LegacyToolIntegrationError('V2 tool registration did not provide a disposable handle')
    // A grouped host transform may be disabled without rejecting transform().
    // Read the effective registry; submitted edits alone are not acceptance.
    const listed = await Reflect.apply(list, tool, [])
    assertActive()
    assertV2ToolAcceptance(listed, prepared, 'effective registry', assertActive)
  } catch (cause) {
    try { await registration?.dispose?.() }
    catch (cleanupError) { throw new LegacyToolIntegrationError('Tool acceptance and registration cleanup both failed', new AggregateError([cause, cleanupError])) }
    throw new LegacyToolIntegrationError('Host did not accept the complete legacy tool registration: ' + (cause?.message ?? String(cause)), cause)
  }
  return { snapshot, prepared, registered: true, registration, toolExposure }
}
