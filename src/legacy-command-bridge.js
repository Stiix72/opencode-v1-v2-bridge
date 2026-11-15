/**
 * Host-independent execution boundary for V1 command.execute.before hooks.
 * V1 hooks mutate output.parts; V2 command callbacks return void.  We capture
 * the parts and require an explicit delivery capability, never silently
 * injecting a model prompt or dropping the output.
 *
 * This is not a V2 command registration adapter. V2's command dispatch and
 * transcript/UI delivery semantics require live verification.
 */
// A delivery function may require a pre-execution check. Keep that requirement
// attached to its identity rather than inferring it from an RPC object.
const outputReadiness = new WeakMap()
export function bindCommandOutputReadiness(deliver, requireReady) {
  if (typeof deliver !== 'function' || typeof requireReady !== 'function') throw new TypeError('Delivery and readiness functions required')
  if (outputReadiness.has(deliver) && outputReadiness.get(deliver) !== requireReady) throw new TypeError('Command output readiness cannot be replaced')
  outputReadiness.set(deliver, requireReady)
  return deliver
}
export function commandOutputReadiness(deliver) { return outputReadiness.get(deliver) }

export class LegacyCommandBridgeError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'LegacyCommandBridgeError'
  }
}

export function validateLegacyCommandParts(parts) {
  if (!Array.isArray(parts)) throw new LegacyCommandBridgeError('Legacy command output.parts must be an array')
  for (const [index, part] of parts.entries()) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || typeof part.type !== 'string') {
      throw new LegacyCommandBridgeError(`Invalid legacy command part at index ${index}`)
    }
    // Non-text parts must be preserved, not guessed at or flattened.
    if (part.type === 'text' && typeof part.text !== 'string') {
      throw new LegacyCommandBridgeError(`Text part ${index} must contain a string`)
    }
  }
  return parts
}

/**
 * Invoke an existing V1 command hook with its original input/output contract.
 * The caller is responsible for extracting a V2 invocation's command name,
 * raw arguments and session identity without lossy parsing.
 */
export async function invokeLegacyCommand(hook, input, { initialParts = [] } = {}) {
  if (typeof hook !== 'function') throw new TypeError('Legacy command hook must be a function')
  if (!input || typeof input !== 'object' || typeof input.command !== 'string' || !input.command) {
    throw new TypeError('Legacy command input must contain a command string')
  }
  if (typeof input.sessionID !== 'string' || !input.sessionID) {
    throw new TypeError('Legacy command input must contain a sessionID')
  }
  validateLegacyCommandParts(initialParts)
  const output = { parts: structuredClone(initialParts) }
  await hook(input, output)
  validateLegacyCommandParts(output.parts)
  return output.parts
}

/**
 * Explicit host delivery boundary. A missing delivery method is an error:
 * V2 session.synthetic({resume:false}) is NOT verified to display immediately.
 * The callback receives all parts and may distinguish model-facing prompts
 * from informational results according to the host's verified semantics.
 */
export async function executeAndDeliverLegacyCommand(hook, input, { deliver, initialParts } = {}) {
  if (typeof deliver !== 'function') {
    throw new LegacyCommandBridgeError('Command output delivery is not configured; refusing to discard legacy parts')
  }
  const requireReady = commandOutputReadiness(deliver)
  let readiness
  if (requireReady) {
    const identity = Object.freeze({ command: input?.command, sessionID: input?.sessionID })
    try {
      const evidence = await requireReady(identity)
      if (evidence?.state !== 'ready' || evidence.sessionID !== identity.sessionID || evidence.command !== identity.command ||
          ['activationID', 'readinessID', 'consumerID'].some(key => typeof evidence[key] !== 'string' || !evidence[key])) {
        throw new TypeError('Confirmed consumer readiness was not established for this command and session')
      }
      if (input.command !== identity.command || input.sessionID !== identity.sessionID) throw new TypeError('Command identity changed during readiness')
      readiness = evidence
    } catch (error) {
      throw new LegacyCommandBridgeError('Legacy command not executed: confirmed output consumer readiness failed', error)
    }
  }
  const parts = await invokeLegacyCommand(hook, input, { initialParts })
  try {
    if (readiness && (input.command !== readiness.command || input.sessionID !== readiness.sessionID)) {
      throw new TypeError('Command identity changed after execution; refusing output for an unchecked session or command')
    }
    const output = { sessionID: input.sessionID, command: input.command, parts }
    if (readiness) await deliver(output, readiness)
    else await deliver(output)
  } catch (error) {
    throw new LegacyCommandBridgeError('Legacy command executed but output delivery failed; do not retry automatically', error)
  }
  return parts
}
