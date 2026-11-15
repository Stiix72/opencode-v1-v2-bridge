/**
 * Optional confirmed command-output protocol. Native RPC method calls return
 * output directly (client/promise/rpc.ts); events alone have no consumer receipt.
 * No retries. The deadline bounds receipt failure, not a UI polling interval.
 */
import { lifecycleTimeout, settleLegacyCleanup } from './legacy-lifecycle.js'
import { bindCommandOutputReadiness } from './legacy-command-bridge.js'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { CommandOutputTransportError, commandPartsToText } from './v2-rpc-command-output.js'

const readinessError = (state, message) => Object.assign(new CommandOutputTransportError(message), { code: 'readiness-' + state })
const readinessDeadlineError = () => readinessError('indeterminate', 'Confirmed output consumer readiness deadline exceeded; readiness unestablished')
const receiptDeadlineError = () => new CommandOutputTransportError('TUI output receipt deadline exceeded; display unconfirmed')
const disposedError = () => new CommandOutputTransportError('Confirmed output disposed before receipt')
const text = { type: 'string' }
const selectionProperties = { activationID: text, readinessID: text, consumerID: text, directory: text, workspaceID: text, sessionID: text, command: text }
const selectionKeys = ['activationID', 'readinessID', 'consumerID', 'directory', 'sessionID', 'command']
const selectionSchema = { type: 'object', properties: selectionProperties, required: selectionKeys, additionalProperties: false }
const sameOutputSelection = (input, selected) => Boolean(input && selected &&
  [...selectionKeys, 'workspaceID'].every(key => input[key] === selected[key]))
export const confirmedOutputRpcDefinition = Object.freeze({
  id: 'opencode-v1-bridge.command-output-confirmed',
  methods: {
    readiness: {
      input: { type: 'object', properties: { activationID: text, readinessID: text, sessionID: text, command: text, consumerID: text, selectedOutput: { type: 'boolean' }, state: { type: 'string', enum: ['ready', 'unavailable'] }, error: text },
        required: ['activationID', 'readinessID', 'sessionID', 'command', 'consumerID', 'state'], additionalProperties: false },
      output: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false },
    },
    receipt: {
      input: { type: 'object', properties: { deliveryID: text, selection: selectionSchema, status: { type: 'string', enum: ['displayed', 'retained', 'failed'] }, error: text },
        required: ['deliveryID', 'status'], additionalProperties: false },
      output: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false },
    },
  },
  events: { readiness: { schema: {
    type: 'object', properties: { activationID: text, readinessID: text, sessionID: text, command: text, directory: text, workspaceID: text, selectedOutput: { type: 'boolean' } },
    required: ['activationID', 'readinessID', 'sessionID', 'command', 'directory'], additionalProperties: false,
  } }, output: { schema: {
    type: 'object', properties: { deliveryID: text, sessionID: text, command: text, text, activationID: text },
    required: ['deliveryID', 'sessionID', 'command', 'text'], additionalProperties: false,
  } }, selectedOutput: { schema: {
    type: 'object', properties: { deliveryID: text, text, selection: selectionSchema, expiresAt: { type: 'integer' } },
    required: ['deliveryID', 'text', 'selection', 'expiresAt'], additionalProperties: false,
  } } },
})

export async function registerConfirmedCommandOutput(ctx, { receiptTimeoutMs = 5000, lifecycleTimeoutMs } = {}) {
  const timeoutMs = lifecycleTimeout(lifecycleTimeoutMs)
  if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 60000) throw new TypeError('Invalid output receipt deadline')
  if (typeof ctx?.rpc?.register !== 'function') throw new CommandOutputTransportError('Promise RPC registration required')
  const pending = new Map(), checks = new Map(), publications = new Map(), readyEvidence = new WeakSet(), activationID = randomUUID()
  const scope = typeof ctx.location?.directory === 'string' && ctx.location.directory
    ? Object.freeze({ directory: ctx.location.directory, ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }) })
    : undefined
  let closed = false, closing
  const ownsLocation = () => scope && ctx.location?.directory === scope.directory && ctx.location?.workspaceID === scope.workspaceID
  const registration = await ctx.rpc.register(confirmedOutputRpcDefinition, {
    async readiness(input) {
      const entry = checks.get(input?.readinessID)
      if (!entry || closed || entry.received || entry.failure) return { accepted: false }
      if (input.activationID !== activationID || input.sessionID !== entry.sessionID || input.command !== entry.command ||
          typeof input.consumerID !== 'string' || !input.consumerID || !['ready', 'unavailable'].includes(input.state)) return { accepted: false }
      if (input.state === 'ready' && input.selectedOutput !== true) return { accepted: false }
      if (performance.now() >= entry.deadlineAt) { entry.cancel(readinessDeadlineError()); return { accepted: false } }
      entry.received = true
      if (input.state === 'unavailable') entry.reject(readinessError('unavailable', 'Confirmed output consumer unavailable: ' + (input.error ?? 'consumer rejected readiness')))
      else entry.resolve(Object.freeze({ state: 'ready', activationID, readinessID: input.readinessID, consumerID: input.consumerID, sessionID: entry.sessionID, command: entry.command }))
      return { accepted: true }
    },
    async receipt(input) {
      const entry = pending.get(input?.deliveryID)
      if (!entry || closed || entry.received || entry.failure) return { accepted: false }
      if (entry.selection ? !ownsLocation() || !sameOutputSelection(input.selection, entry.selection) : input.selection !== undefined) return { accepted: false }
      // A delayed timer callback cannot extend the receipt's authorization window.
      if (performance.now() >= entry.deadlineAt) {
        entry.cancel(receiptDeadlineError())
        return { accepted: false }
      }
      if (!['displayed', 'retained', 'failed'].includes(input.status)) throw new CommandOutputTransportError('Invalid receipt status')
      entry.received = true
      if (input.status === 'failed') entry.reject(new CommandOutputTransportError(`TUI output delivery failed: ${input.error ?? 'unspecified consumer error'}`))
      else entry.resolve(Object.freeze({ status: input.status, deliveryID: input.deliveryID }))
      return { accepted: true }
    },
  })
  if (typeof registration?.events?.emit !== 'function' || typeof registration?.dispose !== 'function') {
    const error = new CommandOutputTransportError('Invalid confirmed RPC registration')
    if (typeof registration?.dispose !== 'function') { error.cleanupFailed = true; throw error }
    try { await settleLegacyCleanup([() => registration.dispose()], { timeoutMs, labels: ['confirmed invalid registration disposal'] }) } catch (cause) {
      const failure = new AggregateError([error, cause], 'Invalid confirmed RPC registration and rollback failed')
      failure.cleanupFailed = true
      failure.cleanupDone = cause.cleanupDone
      throw failure
    }
    throw error
  }
  const publish = (name, data) => {
    let resolve, reject
    const operation = new Promise((yes, no) => { resolve = yes; reject = no })
    // Ownership must exist before external code can synchronously reenter dispose().
    publications.set(operation, name === 'readiness' ? 'confirmed readiness publication' : 'confirmed output publication')
    operation.then(() => publications.delete(operation), () => publications.delete(operation))
    try { resolve(registration.events.emit(name, data)) }
    catch (error) { reject(error) }
    return operation
  }
  async function assertReady(input) {
    if (closed) throw readinessError('disposed', 'Confirmed output activation is disposed')
    if (!input || typeof input.sessionID !== 'string' || !input.sessionID || typeof input.command !== 'string' || !input.command) throw new TypeError('Readiness requires sessionID and command')
    const identity = { sessionID: input.sessionID, command: input.command }
    const assertActive = () => {
      if (closed) throw readinessError('disposed', 'Confirmed output activation is disposed')
      if (!ownsLocation()) throw readinessError('unavailable', 'Confirmed output location ownership is unavailable or changed')
      if (entry.failure) throw entry.failure
      if (performance.now() >= entry.deadlineAt) { entry.cancel(readinessDeadlineError()); throw entry.failure }
    }
    if (!scope) throw readinessError('unavailable', 'Confirmed command readiness requires an explicit native location')
    if (scope.workspaceID !== undefined) throw readinessError('unavailable', 'Public command-output RPC cannot route receipts by workspace')
    const readinessID = randomUUID()
    let resolve, reject, expire, finish
    const reply = new Promise((yes, no) => { resolve = yes; reject = no })
    const deadline = new Promise((_, no) => { expire = no })
    const entry = { ...identity, resolve, reject, received: false, failure: undefined, deadlineAt: performance.now() + receiptTimeoutMs,
      cancel(error) { if (!entry.failure) { entry.failure = error; expire(error) } },
      done: new Promise(yes => { finish = yes }),
    }
    const timer = setTimeout(() => entry.cancel(readinessDeadlineError()), receiptTimeoutMs)
    checks.set(readinessID, entry)
    const publication = Promise.resolve().then(() => {
      assertActive()
      return publish('readiness', { activationID, readinessID, ...identity, ...scope, selectedOutput: true })
    })
    try {
      const result = await Promise.race([Promise.all([publication, reply]).then(([, evidence]) => evidence), deadline])
      assertActive()
      readyEvidence.add(result)
      return result
    } finally { clearTimeout(timer); checks.delete(readinessID); finish() }
  }
  const transport = {
    assertReady,
    async deliver({ sessionID, command, parts }, readiness) {
      if (closed) throw new CommandOutputTransportError('Confirmed command output transport is closed')
      if (typeof sessionID !== 'string' || !sessionID || typeof command !== 'string' || !command) throw new CommandOutputTransportError('Output requires sessionID and command')
      let selection
      if (readiness !== undefined) {
        if (!readyEvidence.delete(readiness) || readiness.sessionID !== sessionID || readiness.command !== command || !ownsLocation()) {
          throw new CommandOutputTransportError('Confirmed output readiness is stale, mismatched or already used')
        }
        selection = Object.freeze({ activationID, readinessID: readiness.readinessID, consumerID: readiness.consumerID, sessionID, command, ...scope })
      }
      const text = commandPartsToText(parts)
      if (!text) return Object.freeze({ status: 'empty' })
      const deliveryID = randomUUID()
      let resolve, reject
      const receipt = new Promise((yes, no) => { resolve = yes; reject = no })
      let expire
      const deadline = new Promise((_, no) => { expire = no })
      const entry = { resolve, reject, selection, received: false, failure: undefined,
        deadlineAt: performance.now() + receiptTimeoutMs,
        cancel(error) {
          if (entry.failure) return
          entry.failure = error
          expire(error)
        },
      }
      const timer = setTimeout(() => entry.cancel(receiptDeadlineError()), receiptTimeoutMs)
      let finish
      const done = new Promise(yes => { finish = yes })
      entry.done = done
      pending.set(deliveryID, entry)
      const assertActive = () => {
        if (closed) throw disposedError()
        if (selection && !ownsLocation()) throw new CommandOutputTransportError('Confirmed output location ownership changed')
        if (entry.failure) throw entry.failure
        if (performance.now() >= entry.deadlineAt) {
          entry.cancel(receiptDeadlineError())
          throw entry.failure
        }
      }
      const expiresAt = Date.now() + receiptTimeoutMs
      // Register the rejection handler before publishing, including a synchronous
      // consumer receipt. A disconnected/no-consumer stream must fail by deadline.
      const publication = Promise.resolve().then(() => {
        // Disposal/expiry may occur after deliver() queues this microtask.
        assertActive()
        // Older companions subscribe only to output. An unaddressed copy
        // would let them display selected output and race its receipt.
        return selection
          ? publish('selectedOutput', { deliveryID, text, selection, expiresAt })
          : publish('output', { deliveryID, sessionID, command, text, activationID })
      })
      try {
        const result = await Promise.race([Promise.all([publication, receipt]).then(([, result]) => result), deadline])
        // A receipt cannot make late publication or disposed completion successful.
        assertActive()
        return result
      }
      finally { clearTimeout(timer); pending.delete(deliveryID); finish() }
    },
    dispose() {
      if (!closing) {
        closed = true
        const entries = [...pending.values(), ...checks.values()]
        for (const entry of entries) entry.cancel(disposedError())
        const operations = [...publications]
        const tasks = [...entries.map(entry => () => entry.done), ...operations.map(([operation]) => () => operation)]
        closing = settleLegacyCleanup([...tasks, () => registration.dispose()], {
          timeoutMs, label: 'Confirmed output transport cleanup failed',
          labels: [...entries.map(() => 'confirmed caller settlement'), ...operations.map(([, label]) => label), 'confirmed RPC registration disposal'],
          dependencies: [...tasks.map(() => []), tasks.map((_, index) => index)],
        })
      }
      return closing
    },
  }
  bindCommandOutputReadiness(transport.deliver, assertReady)
  return Object.freeze(transport)
}
