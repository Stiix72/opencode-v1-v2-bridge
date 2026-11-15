import { lifecycleTimeout, settleLegacyCleanup } from './legacy-lifecycle.js'
import { randomUUID } from 'node:crypto'
import { confirmedOutputRpcDefinition } from './v2-command-output-receipts.js'
/**
 * OpenCode v2.0.27 Promise RPC event transport for legacy command output.
 * No model calls, synthetic session messages, or undocumented ctx.client.
 * This is a notification transport, NOT a transcript renderer.
 */
export const COMMAND_OUTPUT_RPC_ID = 'opencode-v1-bridge.command-output'

const string = { type: 'string' }
export const commandOutputRpcDefinition = Object.freeze({
  id: COMMAND_OUTPUT_RPC_ID,
  methods: Object.freeze({}),
  events: Object.freeze({
    output: Object.freeze({ schema: {
      type: 'object',
      properties: { sessionID: string, command: string, text: string },
      required: ['sessionID', 'command', 'text'],
      additionalProperties: false,
    } }),
  }),
})

export class CommandOutputTransportError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'CommandOutputTransportError'
  }
}

export function commandPartsToText(parts) {
  if (!Array.isArray(parts)) throw new CommandOutputTransportError('Expected legacy command parts array')
  const texts = []
  for (const [index, part] of parts.entries()) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') {
      throw new CommandOutputTransportError(`Cannot render non-text command part at index ${index}`)
    }
    texts.push(part.text)
  }
  return texts.join('\n')
}

/** Registration is per plugin setup; caller must dispose on shutdown. */
export async function registerRpcCommandOutput(ctx, { lifecycleTimeoutMs } = {}) {
  const timeoutMs = lifecycleTimeout(lifecycleTimeoutMs)
  if (typeof ctx?.rpc?.register !== 'function') {
    throw new CommandOutputTransportError('OpenCode v2.0.27 ctx.rpc.register is required')
  }
  const registration = await ctx.rpc.register(commandOutputRpcDefinition, {})
  if (typeof registration?.events?.emit !== 'function' || typeof registration?.dispose !== 'function') {
    const error = new CommandOutputTransportError('RPC registration must expose events.emit and dispose')
    if (typeof registration?.dispose !== 'function') { error.cleanupFailed = true; throw error }
    try { await settleLegacyCleanup([() => registration.dispose()], { timeoutMs, labels: ['command-output invalid registration disposal'] }) } catch (cause) {
      const failure = new AggregateError([error, cause], 'Invalid output RPC registration and rollback failed')
      failure.cleanupFailed = true
      failure.cleanupDone = cause.cleanupDone
      throw failure
    }
    throw error
  }
  let closed = false
  const pending = new Set()
  let disposing
  return Object.freeze({
    async deliver({ sessionID, command, parts }) {
      if (closed) throw new CommandOutputTransportError('Command output transport is closed')
      if (typeof sessionID !== 'string' || !sessionID || typeof command !== 'string' || !command) {
        throw new CommandOutputTransportError('Command output requires sessionID and command')
      }
      const text = commandPartsToText(parts)
      if (!text) return // Empty legacy result requires no notification.
      const delivery = Promise.resolve().then(() => registration.events.emit('output', { sessionID, command, text }))
      pending.add(delivery)
      try { await delivery } finally { pending.delete(delivery) }
    },
    dispose() {
      if (disposing) return disposing
      closed = true
      // Registration disposal is dependent on actual emitter settlement.
      // Timeout reports uncertainty; it never cancels an accepted publication.
      const operations = [...pending]
      disposing = settleLegacyCleanup([
        ...operations.map(operation => () => operation),
        () => registration.dispose(),
      ], {
        timeoutMs, label: 'Command output transport cleanup failed',
        labels: [...operations.map(() => 'command-output publication'), 'command-output RPC registration disposal'],
        dependencies: [...operations.map(() => []), operations.map((_, index) => index)],
      })
      return disposing
    },
  })
}

/**
 * The legacy channel guarantees publication only. Confirmed delivery is opt-in
 * on the producer and is also consumed here when confirmedDelivery is true.
 * A receipt records successful UI dispatch by the consumer or retention for
 * another session. Missing/disconnected consumers time out.
 */
export function createCommandOutputTuiCompanion({
  maxToastLength = 1200, onLongOutput, renderLongOutput,
  createRevision = () => [() => 0, () => {}], confirmedDelivery = false,
} = {}) {
  if (!Number.isSafeInteger(maxToastLength) || maxToastLength < 1) throw new TypeError('Invalid maxToastLength')
  if (onLongOutput !== undefined && typeof onLongOutput !== 'function') throw new TypeError('onLongOutput must be a function')
  if (renderLongOutput !== undefined && typeof renderLongOutput !== 'function') throw new TypeError('renderLongOutput must be a function')
  if (typeof createRevision !== 'function' || typeof confirmedDelivery !== 'boolean') throw new TypeError('Invalid output consumer options')
  return Object.freeze({
    id: 'opencode-v1-bridge-output-tui',
    setup(context) {
      if (typeof context?.client?.rpc !== 'function' || typeof context?.ui?.toast?.show !== 'function') {
        throw new CommandOutputTransportError('TUI requires client.rpc and ui.toast.show')
      }
      const client = context.client.rpc(commandOutputRpcDefinition)
      if (typeof client?.events?.on !== 'function') throw new CommandOutputTransportError('TUI RPC events.on is required')
      const [revision, setRevision] = createRevision()
      if (typeof revision !== 'function' || typeof setRevision !== 'function') throw new TypeError('Output revision factory requires accessor and setter')
      let closed = false, outputActivation, selectedOutputFailed = false
      const consumerID = randomUUID(), clientOwner = context.client, rpcFactory = context.client.rpc
      const toastOwner = context.ui.toast, toastShow = context.ui.toast.show
      const longBySession = new Map(), seenDeliveries = new Map(), unsubscribers = []
      const currentLocation = () => context.location ?? context.data?.location?.default?.()
      const sameLocation = (a, b) => Boolean(a && b && a.directory === b.directory && a.workspaceID === b.workspaceID)
      const currentCapabilities = () => context.client === clientOwner && context.client.rpc === rpcFactory &&
        context.ui?.toast === toastOwner && context.ui.toast.show === toastShow
      const rpcLocation = ({ directory }) => ({ location: { directory } })
      let unregisterSlot
      const cleanup = () => {
        if (closed) return
        closed = true
        const errors = []
        for (const stop of [...unsubscribers.reverse(), unregisterSlot].filter(Boolean)) {
          try { stop() } catch (error) { errors.push(error) }
        }
        longBySession.clear()
        seenDeliveries.clear()
        try { setRevision(value => value + 1) } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Command-output consumer cleanup failed')
      }
      try {
        if (renderLongOutput) {
          if (typeof context.ui?.slot !== 'function' || typeof context.ui?.panel?.open !== 'function' || typeof context.ui?.router?.current !== 'function') {
            throw new CommandOutputTransportError('Long-output panel requires ui.slot, ui.panel.open and ui.router.current')
          }
          unregisterSlot = context.ui.slot({
            append: 'session.panel',
            render: input => input.name === 'opencode-v1-bridge-output'
              ? renderLongOutput(longBySession.get(input.sessionID), input, context,
                () => { revision(); return longBySession.get(input.sessionID) })
              : undefined,
          })
          if (typeof unregisterSlot !== 'function') {
            unregisterSlot = undefined
            throw new CommandOutputTransportError('ui.slot must return cleanup')
          }
        }
        const receive = async (event, strict = false) => {
          if (closed) {
            if (strict) throw new CommandOutputTransportError('TUI output consumer disposed')
            return
          }
          const data = event?.data
          if (!data || typeof data.sessionID !== 'string' || !data.sessionID ||
              typeof data.command !== 'string' || !data.command || typeof data.text !== 'string') {
            if (strict) throw new CommandOutputTransportError('Malformed confirmed output')
            return
          }
          if (data.text.length > maxToastLength) {
            if (renderLongOutput) {
              const previous = longBySession.get(data.sessionID)
              const history = previous?.history ?? (previous ? [{ command: previous.command, text: previous.text }] : [])
              const next = Object.freeze({ command: data.command, text: data.text })
              longBySession.set(data.sessionID, previous ? Object.freeze({
                sessionID: data.sessionID, command: data.command, text: data.text,
                history: Object.freeze([...history, next]),
              }) : Object.freeze({ ...data }))
              // Invalidate text computations; do not rerun or remount the slot.
              setRevision(value => value + 1)
              const route = context.ui.router.current()
              let opened = false
              const active = route?.type === 'session' && route.sessionID === data.sessionID
              if (active) {
                try {
                  const current = context.ui.panel.current?.()
                  opened = current?.name === 'opencode-v1-bridge-output' && current.sessionID === data.sessionID
                    ? true : context.ui.panel.open('opencode-v1-bridge-output') === true
                } catch { /* Preserve full data and report failure below. */ }
              }
              context.ui.toast.show({
                title: `/${data.command}`,
                message: opened ? 'Full output opened in the session panel.' : 'Full output retained for the session, but a panel could not open here.',
                variant: opened ? 'info' : 'warning', sessionID: data.sessionID,
              })
              if (strict && active && !opened) throw new CommandOutputTransportError('Full output retained but active session panel unavailable')
              return { status: opened ? 'displayed' : 'retained' }
            }
            if (onLongOutput) { await onLongOutput(data, context); return { status: 'displayed' } }
            context.ui.toast.show({ title: `/${data.command}`, message: 'Output too long for toast; full output is not displayed.', variant: 'warning', sessionID: data.sessionID })
            if (strict) throw new CommandOutputTransportError('No long-output renderer available')
            return
          }
          context.ui.toast.show({ title: `/${data.command}`, message: data.text, variant: 'info', sessionID: data.sessionID })
          return { status: 'displayed' }
        }
        const subscribe = (rpc, callback, name = 'output') => {
          const stop = rpc.events.on(name, callback)
          if (typeof stop !== 'function') throw new CommandOutputTransportError('TUI RPC subscription must return cleanup')
          unsubscribers.push(stop)
        }
        subscribe(client, receive)
        if (confirmedDelivery) {
          const confirmed = context.client.rpc(confirmedOutputRpcDefinition)
          if (typeof confirmed?.receipt !== 'function' || typeof confirmed?.events?.on !== 'function') throw new CommandOutputTransportError('Confirmed output RPC unavailable')
          // A fresh companion setup may bind one producer activation. It never
          // silently adopts a later activation through an old subscription.
          if (typeof confirmed.readiness === 'function') subscribe(confirmed, async event => {
            if (closed) return
            const data = event?.data
            if (!data || ['activationID', 'readinessID', 'sessionID', 'command', 'directory'].some(key => typeof data[key] !== 'string' || !data[key])) return
            if (!sameLocation(currentLocation(), data) || !sameLocation(event.location, data)) return
            if (outputActivation !== undefined && outputActivation !== data.activationID) return
            outputActivation = data.activationID
            const usable = !selectedOutputFailed && currentCapabilities()
            await confirmed.readiness({
              activationID: data.activationID, readinessID: data.readinessID, sessionID: data.sessionID, command: data.command,
              consumerID, ...(data.selectedOutput === true ? { selectedOutput: true } : {}), state: usable ? 'ready' : 'unavailable',
              ...(usable ? {} : { error: 'Native output consumer capabilities changed' }),
            }, rpcLocation(data))
          }, 'readiness')
          subscribe(confirmed, async event => {
            const deliveryID = event?.data?.deliveryID
            if (typeof deliveryID !== 'string' || !deliveryID) throw new CommandOutputTransportError('Confirmed output missing deliveryID')
            const eventActivation = event.data.activationID
            if (eventActivation !== undefined) {
              if (typeof eventActivation !== 'string' || !eventActivation || outputActivation !== undefined && outputActivation !== eventActivation) return
              outputActivation = eventActivation
            }
            const { deliveryID: _, activationID: _activation, ...data } = event.data
            let result
            try { result = await receive({ data }, true); if (closed) throw new CommandOutputTransportError('TUI output consumer disposed during delivery') }
            catch (error) { result = { status: 'failed', error: error?.message ?? String(error) } }
            // Method errors are allowed to propagate; producer then times out.
            await confirmed.receipt({ deliveryID, ...result })
          })
          if (typeof confirmed.readiness === 'function') subscribe(confirmed, async event => {
            const { deliveryID, selection, expiresAt, text } = event?.data ?? {}
            if (closed || !selection || selection.consumerID !== consumerID || outputActivation !== selection.activationID ||
                !sameLocation(event.location, selection) || typeof deliveryID !== 'string' || !deliveryID ||
                !Number.isSafeInteger(expiresAt)) return
            const now = Date.now()
            for (const [id, expiry] of seenDeliveries) if (expiry <= now) seenDeliveries.delete(id)
            if (expiresAt <= now || seenDeliveries.has(deliveryID)) return
            seenDeliveries.set(deliveryID, expiresAt)
            const assertCurrent = () => {
              if (closed) throw new CommandOutputTransportError('TUI output consumer disposed during delivery')
              if (!sameLocation(currentLocation(), selection) || !currentCapabilities()) {
                throw new CommandOutputTransportError('Native output consumer ownership or capabilities changed')
              }
            }
            let result
            try {
              assertCurrent()
              result = await receive({ data: { sessionID: selection.sessionID, command: selection.command, text } }, true)
              assertCurrent()
            } catch (error) {
              result = { status: 'failed', error: typeof error?.message === 'string' ? error.message : String(error) }
            }
            try {
              await confirmed.receipt({ deliveryID, selection, ...result }, rpcLocation(selection))
            } catch (error) {
              // makeRpc closes this subscription when the callback rejects.
              // Do not continue advertising readiness on its other stream.
              selectedOutputFailed = true
              throw error
            }
          }, 'selectedOutput')
        }
      } catch (error) {
        try { cleanup() } catch (cause) { throw new AggregateError([error, cause], 'Output setup rollback failed') }
        throw error
      }
      return cleanup
    },
  })
}
