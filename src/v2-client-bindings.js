/**
 * Narrow OpenCode V2 -> V1 client adapter.
 * This module does not guess alternate SDK methods or claim live verification.
 * This is the retained explicit external-client carrier, not a native Promise Context.
 * Every forwarded call uses the original V1 request payload unchanged.
 */
export class V2ClientBindingError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2ClientBindingError'
  }
}

function requireMethod(root, path, label) {
  let owner = root
  for (const key of path.slice(0, -1)) owner = owner?.[key]
  const method = owner?.[path.at(-1)]
  if (typeof method !== 'function') throw new V2ClientBindingError(`${label} is unavailable`)
  return (...args) => method.apply(owner, args)
}

/**
 * Builds the exact two client methods used by the known personality plugin.
 * If a host method is unavailable, activation fails before the legacy factory
 * executes. No success-shaped placeholder responses are fabricated.
 */
export function createV2LegacyClient(ctx, { shell } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new V2ClientBindingError('V2 context is required')
  if ('location' in ctx) throw new V2ClientBindingError('Native Promise Context has no ctx.client; use the native PluginInput provider or an explicit makeLegacyInput adapter')
  if (shell !== undefined && typeof shell !== 'function') throw new V2ClientBindingError('shell must be a function')
  const log = requireMethod(ctx.client, ['app', 'log'], 'ctx.client.app.log')
  const showToast = requireMethod(ctx.client, ['tui', 'showToast'], 'ctx.client.tui.showToast')
  return Object.freeze({ log, showToast, ...(shell ? { shell } : {}) })
}

/**
 * Provider for createV2BridgeDefinition({legacyClient}). Keeps the native
 * methods bound to their original owner, including methods using `this`.
 */
export const makeV2LegacyClient = ctx => createV2LegacyClient(ctx)
