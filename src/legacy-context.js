/**
 * Conservative V1 context shim for independently hosted legacy plugins.
 * No native OpenCode API is assumed: callers provide the operations they can
 * actually support. Unsupported methods fail explicitly instead of silently
 * pretending to work.
 */
import { isAbsolute } from 'node:path'

export class UnsupportedLegacyAPIError extends Error {
  constructor(api) {
    super(`Legacy API ${api} is not supported by this bridge context`)
    this.name = 'UnsupportedLegacyAPIError'
    this.api = api
  }
}

const unsupported = (api) => async () => { throw new UnsupportedLegacyAPIError(api) }

function assertDirectory(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`)
  return value
}

/**
 * Construct the subset of V1 PluginInput required by known personality tools.
 * Deliberately require actual client operations rather than supplying fake
 * success responses for UI notifications or application logging.
 */
export function createLegacyInput({ directory, worktree = directory, log, showToast, shell } = {}) {
  assertDirectory(directory, 'directory')
  assertDirectory(worktree, 'worktree')
  if (log !== undefined && typeof log !== 'function') throw new TypeError('log must be a function')
  if (showToast !== undefined && typeof showToast !== 'function') throw new TypeError('showToast must be a function')
  if (shell !== undefined && typeof shell !== 'function') throw new TypeError('shell must be a function')

  return Object.freeze({
    directory,
    worktree,
    $: shell ?? unsupported('$'),
    client: Object.freeze({
      app: Object.freeze({ log: log ?? unsupported('client.app.log') }),
      tui: Object.freeze({ showToast: showToast ?? unsupported('client.tui.showToast') }),
    }),
  })
}

/**
 * Convert a V2 tool invocation to the V1 ToolContext shape.
 * Only capabilities with an actual implementation are enabled. A caller may
 * supply directory/worktree per invocation, rather than accidentally using
 * the plugin's initial workspace for unrelated sessions.
 */
export function createLegacyToolContext({
  sessionID, messageID, agent, directory, worktree = directory, abort,
  metadata, ask,
} = {}) {
  for (const [name, value] of Object.entries({ sessionID, messageID, agent })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a nonempty string`)
  }
  assertDirectory(directory, 'directory')
  assertDirectory(worktree, 'worktree')
  if (abort !== undefined && !(abort instanceof AbortSignal)) throw new TypeError('abort must be an AbortSignal')
  if (metadata !== undefined && typeof metadata !== 'function') throw new TypeError('metadata must be a function')
  if (ask !== undefined && typeof ask !== 'function') throw new TypeError('ask must be a function')
  return Object.freeze({
    sessionID, messageID, agent, directory, worktree,
    abort: abort ?? new AbortController().signal,
    metadata: metadata ?? unsupported('ToolContext.metadata'),
    ask: ask ?? unsupported('ToolContext.ask'),
  })
}
