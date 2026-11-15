/** Optional Promise/TUI fallback. Publication is not UI acceptance. */
import { lifecycleTimeout, settleLegacyCleanup } from './legacy-lifecycle.js'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { record, jsonCopy, freeze, failure, timeout } from './client-capability-contract.js'

export const LEGACY_CLIENT_RPC_ID = 'opencode-v1-bridge.legacy-client'
const string = { type: 'string' }, version = { type: 'integer', enum: [1] }
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const locationSchema = object({ directory: string, workspaceID: string }, ['directory'])
const identity = { protocol: version, activationID: string, consumerID: string, location: locationSchema }
const accepted = object({ accepted: { type: 'boolean' } })
const toastSchema = object({ message: string, title: string, variant: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
  duration: { type: 'number' }, sessionID: string }, ['message'])
export const legacyClientRpcDefinition = freeze({
  id: LEGACY_CLIENT_RPC_ID,
  methods: {
    describe: { input: object({ protocol: version }), output: object({ protocol: version, activationID: string, location: locationSchema,
      receiptTimeoutMs: { type: 'integer' } }) },
    claim: { input: object(identity), output: accepted },
    release: { input: object(identity), output: accepted },
    receipt: { input: object({ ...identity, deliveryID: string, sessionID: string, status: { type: 'string', enum: ['accepted-by-ui', 'failed'] }, error: string },
      [...Object.keys(identity), 'deliveryID', 'status']), output: accepted },
  },
  events: { toast: { schema: object({ ...identity, deliveryID: string, expiresAt: { type: 'integer' }, toast: toastSchema, sessionID: string }, [...Object.keys(identity), 'deliveryID', 'expiresAt', 'toast']) } },
})

export function validateLegacyToast(request) {
  const body = request?.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.message !== 'string' || !body.message.trim()) {
    throw new TypeError('Legacy toast requires body.message string')
  }
  const allowed = new Set(['message', 'title', 'variant', 'duration', 'sessionID'])
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) throw new TypeError('Unsupported legacy toast property: ' + key)
    if (key === 'variant' && !['info', 'success', 'warning', 'error'].includes(value)) throw new TypeError('Invalid toast variant')
    if (['message', 'title', 'sessionID'].includes(key) && typeof value !== 'string') throw new TypeError('Invalid toast ' + key)
    if (key === 'duration' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new TypeError('Invalid toast duration')
  }
  return jsonCopy(record(body, 'legacy toast', [...allowed]))
}
function locationOf(value) {
  record(value, 'toast location', ['directory', 'workspaceID'])
  if (typeof value.directory !== 'string' || !value.directory || value.workspaceID !== undefined && (typeof value.workspaceID !== 'string' || !value.workspaceID)) throw new TypeError('Explicit native toast location required')
  return freeze({ directory: value.directory, ...(value.workspaceID === undefined ? {} : { workspaceID: value.workspaceID }) })
}
// Public routing uses a LocationRef; native Context can supply the richer Location.Info.
const routingLocation = value => locationOf({ directory: value?.directory, ...(value?.workspaceID === undefined ? {} : { workspaceID: value.workspaceID }) })
const sameLocation = (a, b) => a && b && a.directory === b.directory && a.workspaceID === b.workspaceID
const currentLocation = ctx => ctx.location ?? ctx.data?.location?.default?.()
const disposed = () => failure('toast-disposed', 'Legacy client transport closed before toast acceptance')
const expired = () => failure('toast-timeout', 'Toast receipt deadline exceeded; UI acceptance unconfirmed')
function requiredAcceptance(result) {
  record(result, 'toast RPC acknowledgement', ['accepted'])
  if (result.accepted !== true) throw failure('toast-acknowledgement', 'Toast lease/receipt was not accepted')
}

export async function registerLegacyClientTransport(ctx, { log, lifecycleTimeoutMs, toastReceiptTimeoutMs } = {}) {
  const timeoutMs = lifecycleTimeout(lifecycleTimeoutMs), receiptMs = timeout(toastReceiptTimeoutMs)
  if (typeof log !== 'function') throw new TypeError('A verified host log binding is required')
  if (typeof ctx?.rpc?.register !== 'function') throw new TypeError('Promise RPC registration is required')
  const rpcOwner = ctx.rpc, register = rpcOwner.register, activationID = randomUUID()
  // Logging remains available when no explicit native location can be established.
  let scope
  try { scope = routingLocation(ctx.location) } catch {}
  const toasts = new Map(), publications = new Map()
  let registration, closed = false, consumerID, readiness = 'unestablished'
  const check = () => {
    if (closed) throw disposed()
    if (scope?.workspaceID !== undefined) throw failure('toast-routing-unsupported', 'Exact public RPC client cannot route workspace-specific toast acceptance')
    if (!scope || !sameLocation(ctx.location, scope) || ctx.rpc !== rpcOwner || rpcOwner.register !== register) throw failure('toast-ownership', 'Native toast location/RPC ownership unavailable or changed')
  }
  const matches = (input, extra = []) => {
    try {
      record(input, 'toast identity', [...Object.keys(identity), ...extra])
      check(); locationOf(input.location)
      return input.protocol === 1 && input.activationID === activationID && typeof input.consumerID === 'string' &&
        !!input.consumerID && sameLocation(input.location, scope)
    } catch { return false }
  }
  registration = await Reflect.apply(register, rpcOwner, [legacyClientRpcDefinition, {
    async describe(input) {
      record(input, 'toast description request', ['protocol']); check()
      if (input.protocol !== 1) throw failure('toast-protocol', 'Unsupported toast receipt protocol')
      return { protocol: 1, activationID, location: scope, receiptTimeoutMs: receiptMs }
    },
    async claim(input) {
      if (!matches(input) || consumerID) return { accepted: false }
      consumerID = input.consumerID; readiness = 'ready'
      return { accepted: true }
    },
    async release(input) {
      if (!matches(input) || consumerID !== input.consumerID) return { accepted: false }
      consumerID = undefined; readiness = 'released'
      for (const entry of toasts.values()) entry.cancel(failure('toast-consumer-unavailable', 'Selected toast consumer released; UI acceptance unconfirmed'))
      return { accepted: true }
    },
    async receipt(input) {
      if (!matches(input, ['deliveryID', 'sessionID', 'status', 'error'])) return { accepted: false }
      const entry = toasts.get(input.deliveryID)
      if (!entry || entry.received || entry.failure || input.consumerID !== consumerID || entry.consumerID !== input.consumerID ||
        input.sessionID !== entry.sessionID || !['accepted-by-ui', 'failed'].includes(input.status) ||
        input.error !== undefined && typeof input.error !== 'string' || input.status === 'accepted-by-ui' && Object.hasOwn(input, 'error')) return { accepted: false }
      if (performance.now() >= entry.deadlineAt) { entry.cancel(expired()); return { accepted: false } }
      entry.received = true
      if (input.status === 'failed') entry.reject(failure('toast-delivery', 'Native toast acceptance failed: ' + (input.error ?? 'consumer rejected request')))
      else entry.resolve(true)
      return { accepted: true }
    },
  }])
  if (typeof registration?.events?.emit !== 'function' || typeof registration?.dispose !== 'function') {
    const error = new TypeError('Invalid RPC registration')
    if (typeof registration?.dispose !== 'function') { error.cleanupFailed = true; throw error }
    try { await settleLegacyCleanup([() => registration.dispose()], { timeoutMs, labels: ['legacy-client invalid registration disposal'] }) } catch (cause) {
      const failure = new AggregateError([error, cause], 'Invalid client RPC registration and rollback failed')
      failure.cleanupFailed = true; failure.cleanupDone = cause.cleanupDone; throw failure
    }
    throw error
  }
  const emitter = registration.events, emit = emitter.emit, disposeRegistration = registration.dispose
  const pending = new Map()
  let disposing
  const track = async (label, operation) => {
    if (closed) throw new Error('Legacy client transport closed')
    const promise = Promise.resolve().then(operation)
    pending.set(promise, label)
    try { return await promise } finally { pending.delete(promise) }
  }
  const publish = event => {
    let resolve, reject
    const operation = new Promise((yes, no) => { resolve = yes; reject = no })
    // Own publication before invoking foreign emit code, including synchronous disposal.
    publications.set(operation, 'legacy toast publication')
    operation.then(() => publications.delete(operation), () => publications.delete(operation))
    try { resolve(Reflect.apply(emit, emitter, ['toast', event])) } catch (error) { reject(error) }
    return operation
  }
  const deliver = async toast => {
    check()
    if (!consumerID) {
      const error = failure('toast-consumer-unavailable', readiness === 'released' ? 'Selected toast consumer disconnected' : 'Toast consumer readiness has not been established')
      error.readiness = readiness
      throw error
    }
    const selected = consumerID, deliveryID = 'toast:' + randomUUID()
    let resolve, reject, cancel, finish
    const receipt = new Promise((yes, no) => { resolve = yes; reject = no })
    const deadline = new Promise((_, no) => { cancel = no })
    const entry = { consumerID: selected, sessionID: toast.sessionID, received: false, failure: undefined,
      resolve, reject, deadlineAt: performance.now() + receiptMs,
      done: new Promise(yes => { finish = yes }),
      cancel(error) { if (!entry.failure) { entry.failure = error; cancel(error) } } }
    toasts.set(deliveryID, entry)
    const timer = setTimeout(() => entry.cancel(expired()), receiptMs)
    const assertActive = () => {
      check()
      if (entry.failure) throw entry.failure
      if (performance.now() >= entry.deadlineAt) { entry.cancel(expired()); throw entry.failure }
      if (consumerID !== selected) throw failure('toast-consumer-unavailable', 'Toast consumer association changed')
    }
    const publication = Promise.resolve().then(() => {
      assertActive()
      if (registration.events !== emitter || emitter.emit !== emit || registration.dispose !== disposeRegistration) throw failure('toast-ownership', 'Toast registration identity changed')
      return publish(freeze({ protocol: 1, activationID, consumerID: selected, location: scope, deliveryID,
        expiresAt: Date.now() + Math.max(0, Math.ceil(entry.deadlineAt - performance.now())), toast, ...(toast.sessionID === undefined ? {} : { sessionID: toast.sessionID }) }))
    }).catch(cause => { throw failure('toast-publication', 'Toast publication failed; UI acceptance unconfirmed', cause) })
    try {
      const result = await Promise.race([Promise.all([publication, receipt]).then(([, value]) => value), deadline])
      assertActive()
      return result
    } finally { clearTimeout(timer); toasts.delete(deliveryID); finish() }
  }
  return Object.freeze({
    client: Object.freeze({
      app: Object.freeze({ log: request => track('legacy logger callback', () => log(request)) }),
      tui: Object.freeze({ showToast: request => {
        record(request, 'fallback toast request', ['body'])
        const toast = validateLegacyToast(request)
        return deliver(freeze(toast))
      } }),
    }),
    dispose() {
      if (disposing) return disposing
      closed = true; consumerID = undefined
      const entries = [...toasts.values()]
      for (const entry of entries) entry.cancel(disposed())
      const operations = [...pending, ...publications]
      const tasks = [...entries.map(entry => () => entry.done), ...operations.map(([operation]) => () => operation)]
      disposing = settleLegacyCleanup([...tasks, () => registration.dispose()], {
        timeoutMs, label: 'Legacy client transport cleanup failed',
        labels: [...entries.map(() => 'legacy toast caller settlement'), ...operations.map(([, label]) => label), 'legacy-client RPC registration disposal'],
        dependencies: [...tasks.map(() => []), tasks.map((_, index) => index)],
      })
      return disposing
    },
  })
}

export function createLegacyClientTuiCompanion({ lifecycleTimeoutMs } = {}) {
  const timeoutMs = lifecycleTimeout(lifecycleTimeoutMs)
  return Object.freeze({
    id: 'opencode-v1-bridge-legacy-client-tui',
    async setup(ctx) {
      const client = ctx?.client, factory = client?.rpc, ui = ctx?.ui?.toast, show = ui?.show
      if (typeof factory !== 'function' || typeof show !== 'function') throw new TypeError('TUI RPC/toast unavailable')
      const scope = routingLocation(currentLocation(ctx))
      if (scope.workspaceID !== undefined) throw failure('toast-routing-unsupported', 'Exact public RPC client cannot route workspace-specific toast acceptance')
      const rpc = Reflect.apply(factory, client, [legacyClientRpcDefinition])
      for (const key of ['describe', 'claim', 'receipt', 'release']) if (typeof rpc?.[key] !== 'function') throw new TypeError('Toast RPC ' + key + ' unavailable')
      if (typeof rpc.events?.on !== 'function') throw new TypeError('TUI RPC subscription unavailable')
      const methods = Object.fromEntries(['describe', 'claim', 'receipt', 'release'].map(key => [key, rpc[key]]))
      let description
      try { description = await Reflect.apply(methods.describe, rpc, [{ protocol: 1 }, { location: scope }]) }
      catch (error) {
        // The optional fallback may be absent. Do not tear down unrelated TUI companions.
        if (error?.type === 'rpc.unavailable') { let closing; return () => closing ??= settleLegacyCleanup([], { timeoutMs }) }
        throw error
      }
      record(description, 'toast description', ['protocol', 'activationID', 'location', 'receiptTimeoutMs'])
      locationOf(description.location); timeout(description.receiptTimeoutMs)
      if (description.protocol !== 1 || typeof description.activationID !== 'string' || !description.activationID || !sameLocation(description.location, scope)) throw failure('toast-ownership', 'Foreign or malformed toast activation description')
      const identity = freeze({ protocol: 1, activationID: description.activationID, consumerID: randomUUID(), location: scope })
      let closed = false, unsubscribe, leased = false, closing
      const jobs = new Set(), errors = [], seen = new Map()
      const check = () => {
        if (closed) throw disposed()
        if (!sameLocation(currentLocation(ctx), scope) || ctx.client !== client || client.rpc !== factory || ctx.ui?.toast !== ui || ui.show !== show || Object.keys(methods).some(key => rpc[key] !== methods[key])) throw failure('toast-ownership', 'Native TUI toast ownership changed')
      }
      const onToast = async event => {
        const input = event?.data
        try {
          record(input, 'toast event', [...Object.keys(identity), 'deliveryID', 'expiresAt', 'toast', 'sessionID'])
          locationOf(input.location); locationOf(event.location)
        } catch { return }
        if (closed || input.protocol !== 1 || input.activationID !== identity.activationID || input.consumerID !== identity.consumerID ||
          !sameLocation(input.location, scope) || !sameLocation(event.location, scope) || typeof input.deliveryID !== 'string' ||
          !input.deliveryID.startsWith('toast:') || !Number.isSafeInteger(input.expiresAt) || Date.now() >= input.expiresAt) return
        for (const [id, prior] of seen) if (prior.expiresAt <= Date.now()) seen.delete(id)
        if (seen.has(input.deliveryID)) return seen.get(input.deliveryID).job
        const job = Promise.resolve().then(async () => {
          let status = 'accepted-by-ui', message
          try {
            check()
            if (Date.now() >= input.expiresAt) throw expired()
            const toast = validateLegacyToast({ body: input.toast })
            if (toast.sessionID !== input.sessionID) throw failure('toast-ownership', 'Toast session correlation changed')
            const returned = Reflect.apply(show, ui, [toast])
            if (returned !== undefined) {
              if (returned && typeof returned.then === 'function') await returned
              throw new TypeError('Native Toast.show must return void, not a Promise/result')
            }
            check()
          } catch (error) { status = 'failed'; message = error instanceof Error ? error.message : String(error) }
          if (closed) return
          const reply = { ...identity, deliveryID: input.deliveryID, status,
            ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
            ...(message === undefined ? {} : { error: message }) }
          requiredAcceptance(await Reflect.apply(methods.receipt, rpc, [reply, { location: scope }]))
        })
        const observed = job.then(() => {}, error => { errors.push(error) })
        seen.set(input.deliveryID, { job: observed, expiresAt: input.expiresAt })
        jobs.add(observed); observed.then(() => jobs.delete(observed))
        return observed
      }
      try {
        check(); unsubscribe = rpc.events.on('toast', onToast)
        if (typeof unsubscribe !== 'function') throw new TypeError('TUI subscription cleanup unavailable')
        requiredAcceptance(await Reflect.apply(methods.claim, rpc, [identity, { location: scope }]))
        leased = true; check()
      } catch (error) {
        closed = true
        const cleanup = settleLegacyCleanup([() => unsubscribe?.(), async () => {
          if (leased) requiredAcceptance(await Reflect.apply(methods.release, rpc, [identity, { location: scope }]))
        }, async () => {
          await Promise.allSettled([...jobs]); seen.clear()
          if (errors.length) throw new AggregateError(errors, 'Toast companion setup task failures')
        }], { timeoutMs, label: 'Toast companion setup cleanup failed' })
        try { await cleanup } catch (cause) {
          const failure = new AggregateError([error, cause], 'Toast companion setup and cleanup failed', { cause })
          failure.cleanupFailed = true; failure.cleanupDone = cleanup.cleanupDone; throw failure
        }
        throw error
      }
      return () => {
        if (!closing) {
          closed = true
          const stop = () => unsubscribe()
          const release = async () => { requiredAcceptance(await Reflect.apply(methods.release, rpc, [identity, { location: scope }])) }
          closing = settleLegacyCleanup([stop, release, async () => {
            await Promise.allSettled([...jobs]); seen.clear()
            if (errors.length) throw new AggregateError(errors, 'Toast companion receipt failures')
          }], { timeoutMs, label: 'Toast companion cleanup failed', labels: ['toast listener removal', 'toast lease release', 'toast consumer tasks'] })
        }
        return closing
      }
    },
  })
}
