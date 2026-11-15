import { lifecycleTimeout, settleLegacyCleanup } from './legacy-lifecycle.js'
import { bindCommandOutputReadiness } from './legacy-command-bridge.js'
import { registerConfirmedCommandOutput } from './v2-command-output-receipts.js'
/** Compose the existing native bridge with v2.0.27 RPC command delivery. */
import { createNativeV2BridgeDefinition } from './v2-plugin-entrypoint.js'
import { decodeV2CommandInvocation } from './v2-command-invocation.js'
import { registerRpcCommandOutput } from './v2-rpc-command-output.js'
import { registerLegacyClientTransport } from './v2-rpc-client-transport.js'
import { createStderrLegacyLogger } from './v2-stderr-logging.js'

export function createRpcDeliveredNativeV2BridgeDefinition(options = {}) {
  if (options.stderrLog !== undefined && typeof options.stderrLog !== 'boolean') throw new TypeError('stderrLog must be boolean')
  if (options.stderrLog && options.hostLog !== undefined) throw new TypeError('Choose either stderrLog or hostLog')
  const resolvedLog = options.hostLog
  const stderrStream = options.stderrStream
  if (options.stderrStream !== undefined && !options.stderrLog) throw new TypeError('stderrStream requires stderrLog')
  if ((resolvedLog !== undefined || options.stderrLog) && (options.makeLegacyInput || options.legacyClient)) {
    throw new TypeError('hostLog transport cannot override an explicit legacy input provider')
  }
  const commandNames = options.commandNames ?? ['personality', 'mood']
  if (!Array.isArray(commandNames) || !commandNames.length || commandNames.some(name => typeof name !== 'string' || !/^[a-zA-Z][\w.-]*$/.test(name)) || new Set(commandNames).size !== commandNames.length) {
    throw new TypeError('commandNames must be unique valid command names')
  }
  const bindings = { ...options.bindings, decodeCommand: decodeV2CommandInvocation }
  if (!bindings.commandEntries) {
    bindings.commandEntries = plugin => commandNames.map(name => ({
      name, hook: plugin.hooks['command.execute.before'],
      description: `Legacy /${name} command`,
    }))
  }
  const timeoutMs = lifecycleTimeout(options.lifecycleTimeoutMs ?? bindings.lifecycleTimeoutMs)
  // One activation per definition, including while setup/cleanup is pending.
  // Every callback below closes over its own resources, never the next owner.
  let activation
  return Object.freeze({
    id: options.id ?? 'opencode-v1-bridge',
    async setup(ctx) {
      if (activation) throw new Error('RPC bridge setup refused: activation is ' + activation.phase)
      const owner = { phase: 'starting' }
      activation = owner
      const release = () => { if (activation === owner) activation = undefined }
      let transport, clientTransport, stderrLogger, cleanup
      try {
        transport = options.outputReceiptTimeoutMs === undefined
          ? await registerRpcCommandOutput(ctx, { lifecycleTimeoutMs: timeoutMs })
          : await registerConfirmedCommandOutput(ctx, { receiptTimeoutMs: options.outputReceiptTimeoutMs, lifecycleTimeoutMs: timeoutMs })
        if (options.stderrLog) stderrLogger = createStderrLegacyLogger({ stream: stderrStream, lifecycleTimeoutMs: timeoutMs })
        const log = stderrLogger ?? resolvedLog
        if (log !== undefined) clientTransport = await registerLegacyClientTransport(ctx, { log, lifecycleTimeoutMs: timeoutMs, toastReceiptTimeoutMs: options.toastReceiptTimeoutMs })
        const deliverCommand = (...args) => transport.deliver(...args)
        if (options.outputReceiptTimeoutMs !== undefined) bindCommandOutputReadiness(deliverCommand, async input => {
          if (owner.phase !== 'active') throw new Error('Confirmed command consumer readiness requires an active bridge')
          const evidence = await transport.assertReady(input)
          if (owner.phase !== 'active') throw new Error('Confirmed command activation changed during readiness')
          return evidence
        })
        const native = createNativeV2BridgeDefinition({
          ...options,
          ...(clientTransport ? {
            legacyClient: async () => ({
              log: request => clientTransport.client.app.log(request),
              showToast: request => clientTransport.client.tui.showToast(request),
              ...(options.shell ? { shell: options.shell } : {}),
            }),
            makeLegacyInput: undefined,
          } : {}),
          bindings: { ...bindings, deliverCommand },
        })
        cleanup = await native.setup(ctx)
        owner.phase = 'active'
      } catch (error) {
        const rollback = settleLegacyCleanup([
          () => cleanup?.(), () => transport?.dispose(), () => clientTransport?.dispose(),
          () => error?.cleanupDone, ...(stderrLogger ? [() => stderrLogger.dispose()] : []),
        ], { timeoutMs, label: 'RPC bridge rollback failed',
          labels: ['core activation rollback', 'command-output rollback', 'legacy-client rollback', 'prior initialization cleanup', ...(stderrLogger ? ['owned stderr logger rollback'] : [])] })
        let rollbackError
        try { await rollback } catch (cause) { rollbackError = cause }
        const errors = rollbackError ? rollbackError.code === 'cleanup-timeout' ? [rollbackError] : rollbackError.errors ?? [rollbackError] : []
        // The base lifecycle explicitly reports failed/incomplete rollback.
        // A fresh inner definition must never bypass that quarantine.
        if (error?.cleanupFailed || errors.length) owner.phase = 'quarantined'
        else { owner.phase = 'failed'; release() }
        if (errors.length) {
          const failure = new AggregateError([error, ...errors], 'RPC bridge setup and rollback failed')
          failure.cleanupFailed = true
          failure.cleanupDone = rollback.cleanupDone
          failure.operations = rollbackError?.operations
          throw failure
        }
        throw error
      }
      let closing
      return () => {
        if (!closing) {
          owner.phase = 'stopping'
          const work = settleLegacyCleanup([
            () => cleanup?.(), () => transport.dispose(), () => clientTransport?.dispose(), ...(stderrLogger ? [() => stderrLogger.dispose()] : []),
          ], { timeoutMs, label: 'RPC bridge cleanup failed',
            labels: ['core bridge cleanup', 'command-output transport cleanup', 'legacy-client transport cleanup', ...(stderrLogger ? ['owned stderr logger cleanup'] : [])] })
          closing = work.then(() => {
            owner.phase = 'disposed'
            release()
          }, error => {
            owner.phase = 'quarantined'
            const failure = new AggregateError(error.code === 'cleanup-timeout' ? [error] : error.errors ?? [error], 'RPC bridge cleanup failed')
            failure.cleanupFailed = true
            failure.cleanupDone = work.cleanupDone
            failure.operations = error.operations
            failure.cause = error
            throw failure
          })
          Object.defineProperty(closing, 'cleanupDone', { value: work.cleanupDone })
        }
        return closing
      }
    },
  })
}
