import { mapLegacyToolResult, validateNativeLegacyResult } from './legacy-tool-results.js'
import { snapshotPermissionContext } from './v2-permission-binding.js'
/**
 * Map legacy definitions to the shared public Promise-plugin Tool.Info contract.
 */
export class V2ToolDefinitionError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2ToolDefinitionError'
  }
}

/** V1 text/result records map to content, never undeclared native output. */
export function toV2ToolResult(value, _name, options) {
  try { return mapLegacyToolResult(value, options) }
  catch (cause) { throw new V2ToolDefinitionError('Invalid V1 result: '+cause.message, cause) }
}

/**
 * Maps a staged descriptor to V2 Promise Tool.Info. The invocation context
 * deliberately requires directory/worktree and optional capabilities from
 * the caller; the V2 Tool.Context does not contain those paths.
 */
export function makeV2ToolDefinition(descriptor, {
  makeInvocation,
  convertResult = toV2ToolResult,
  toolExposure = 'direct',
  permissionBinding,
} = {}) {
  if (!['direct', 'code-mode'].includes(toolExposure)) throw new TypeError('toolExposure must be direct or code-mode')
  if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name ||
      typeof descriptor.execute !== 'function' || !descriptor.inputSchema) {
    throw new V2ToolDefinitionError('Invalid staged legacy tool descriptor')
  }
  if (typeof makeInvocation !== 'function') {
    throw new V2ToolDefinitionError(`Tool ${descriptor.name}: makeInvocation is required`)
  }
  if (typeof convertResult !== 'function') throw new V2ToolDefinitionError('convertResult must be a function')
  if (permissionBinding !== undefined && (typeof permissionBinding?.ask !== 'function' || typeof permissionBinding?.dispose !== 'function')) throw new V2ToolDefinitionError('permissionBinding requires ask and dispose')
  // Capture the validated handler and identity before caller-owned descriptors can change.
  const name = descriptor.name
  const description = descriptor.description ?? ''
  const inputSchema = descriptor.inputSchema
  const executeLegacy = descriptor.execute.bind(descriptor)
  return Object.freeze({
    name,
    description,
    input: inputSchema,
    // Both hosts recognize codemode: false for direct exposure.
    options: Object.freeze({ codemode: toolExposure === 'code-mode' }),
    async execute(input, context) {
      const native = permissionBinding ? snapshotPermissionContext(context) : undefined
      let invocation = await makeInvocation(context, name)
      if (permissionBinding) {
        if (!invocation || invocation.ask !== undefined || ['sessionID','messageID','agent'].some(k => invocation[k] !== native[k]) || invocation.abort !== native.signal) throw new V2ToolDefinitionError('Permission binding requires unchanged native identity/signal and exclusive ask ownership')
        invocation = { ...invocation, ask: input => permissionBinding.ask(native, input) }
      }
      const signal = invocation?.abort
      signal?.throwIfAborted()
      const legacyResult = await executeLegacy(input, invocation)
      // On 2.3.0 reading the native signal opts into cooperative stop. A legacy
      // callback can ignore it and return normally during the host's grace period.
      signal?.throwIfAborted()
      const converted = await convertResult(legacyResult, name, { toolExposure })
      let result
      try { result = validateNativeLegacyResult(converted, { toolExposure }) }
      catch (cause) { throw new V2ToolDefinitionError(`Tool ${name}: invalid V2 result: ${cause.message}`, cause) }
      signal?.throwIfAborted()
      return result
    },
  })
}
