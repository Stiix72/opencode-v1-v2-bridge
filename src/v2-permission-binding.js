/** Exact v2.0.27 public-create/native-control permission adapter. No approval policy. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export class LegacyPermissionError extends Error {
  constructor(code, message, cause) {
    super(message, { cause })
    this.name = 'LegacyPermissionError'
    this.code = code
  }
}
const fail = (code, message, cause) => new LegacyPermissionError(code, message, cause)
const nonempty = value => typeof value === 'string' && value.length > 0

// Snapshot without JSON.stringify's lossy conversions, getters or toJSON hooks.
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) throw fail('input', 'Permission metadata must be acyclic JSON')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('input', 'Permission metadata must contain plain JSON objects')
  ancestors.add(value)
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw fail('input', 'Sparse permission metadata is unsupported') }
  const out = Array.isArray(value) ? [] : Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    if (Array.isArray(value) && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) throw fail('input', 'Non-index array metadata properties are unsupported')
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) throw fail('input', 'Permission metadata accessors/symbols are unsupported')
    Object.defineProperty(out, key, { value: json(d.value, ancestors), enumerable: true })
  }
  if (Array.isArray(value) && out.length !== value.length) throw fail('input', 'Sparse permission metadata is unsupported')
  ancestors.delete(value)
  return Object.freeze(out)
}
function strings(value, label, required = false) {
  if (!Array.isArray(value) || (required && !value.length) || value.some(x => typeof x !== 'string')) throw fail('input', `${label} must be a string array${required ? ' with at least one resource' : ''}`)
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw fail('input', `${label} must not be sparse`)
  return Object.freeze([...value])
}
export function snapshotPermissionContext(context) {
  const snapshot = context && Object.fromEntries(['sessionID', 'messageID', 'agent', 'id', 'signal'].map(k => [k, context[k]]))
  if (!snapshot || !['sessionID', 'messageID', 'agent', 'id'].every(k => nonempty(snapshot[k])) ||
      !(snapshot.signal instanceof AbortSignal)) throw fail('context', 'Native tool identity and native AbortSignal are required')
  return Object.freeze(snapshot)
}

/**
 * Requires a public Promise client and plugin ctx.permission controls for the SAME
 * host/location. assertSameHost must validate that identity, not return approval.
 * No host imports, implicit endpoints, auto-approvals, retry of mutations or new
 * permission rules. Native user "always" retains its native project-wide scope.
 * timeout/cancel cleanup uses native reject (same-session batch semantics).
 */
export function createNativePermissionBinding({ client, permission, locationDirectory, assertSameHost,
  timeoutMs = 120000, cleanupTimeoutMs = 5000, confirmationIntervalMs = 20 } = {}) {
  for (const [name, fn] of Object.entries({ create: client?.permission?.create, subscribe: client?.event?.subscribe,
    sessionGet: client?.session?.get, list: permission?.list, reply: permission?.reply, assertSameHost })) {
    if (typeof fn !== 'function') throw fail('capability', `Required native permission capability unavailable: ${name}`)
  }
  if (!nonempty(locationDirectory) || !path.isAbsolute(locationDirectory)) throw fail('capability', 'Explicit absolute host location directory required')
  for (const [name, value] of Object.entries({ timeoutMs, cleanupTimeoutMs, confirmationIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw fail('input', `${name} must be a positive bounded integer`)
  }
  let disposed = false, quarantine
  const active = new Set()
  const normalize = value => path.resolve(value)
  const attest = async context => {
    // A resolved undefined is the normal assertion contract; false is never accepted.
    if (await assertSameHost({ sessionID: context.sessionID, locationDirectory }) === false) throw fail('identity', 'Host identity verification rejected')
    const session = await client.session.get({ sessionID: context.sessionID })
    if (session?.id !== context.sessionID || !nonempty(session?.location?.directory) || normalize(session.location.directory) !== normalize(locationDirectory)) throw fail('identity', 'Session does not belong to the bound host location')
  }
  async function run(context, input, op) {
    const native = snapshotPermissionContext(context)
    if (!input || !nonempty(input.permission) || !input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) throw fail('input', 'Legacy permission, patterns, always and metadata are required')
    const request = Object.freeze({ id: `per_${randomUUID()}`, sessionID: native.sessionID,
      action: input.permission, resources: strings(input.patterns, 'patterns', true), save: strings(input.always, 'always'),
      metadata: json(input.metadata), source: Object.freeze({ type: 'tool', messageID: native.messageID, id: native.id }), agent: native.agent })
    let failure, rejectFailure, wake, ready = false, decision, submitted = false, created = false, watcher, creation
    let completed = false, stopping = false
    const eventAbort = new AbortController()
    const failed = new Promise((_, reject) => { rejectFailure = reject })
    // Every async host operation races failure; failure is never interpreted as approval.
    const stop = error => {
      if (failure || completed) return
      failure = error
      rejectFailure(error)
      wake?.()
    }
    op.stop = stop
    const cancellation = () => stop(fail('cancelled', 'Native tool execution cancelled', native.signal.reason))
    native.signal.addEventListener('abort', cancellation, { once: true })
    const timer = setTimeout(() => stop(fail('timeout', 'Permission authorization deadline exceeded')), timeoutMs)
    const wait = promise => Promise.race([Promise.resolve(promise), failed])
    const pending = async () => {
      const values = await permission.list({ sessionID: native.sessionID })
      if (!Array.isArray(values) || values.some(x => !x || !nonempty(x.id) || x.sessionID !== native.sessionID)) throw fail('protocol', 'Malformed native pending-permission list')
      const matches = values.filter(x => x.id === request.id)
      if (matches.length > 1) throw fail('protocol', 'Duplicate native pending permission')
      const value = matches[0]
      if (value && (value.action !== request.action || JSON.stringify(value.resources) !== JSON.stringify(request.resources) ||
          JSON.stringify(value.save) !== JSON.stringify(request.save) || value.source?.type !== 'tool' ||
          value.source?.messageID !== native.messageID || value.source?.id !== native.id)) throw fail('identity', 'Pending permission ownership mismatch')
      return value
    }
    const pause = ms => new Promise(resolve => {
      const t = setTimeout(done, ms)
      function done() { clearTimeout(t); wake = undefined; resolve() }
      wake = done
    })
    try {
      if (native.signal.aborted) cancellation()
      if (disposed) stop(fail('disposed', 'Permission binding disposed'))
      await wait(attest(native))
      const events = client.event.subscribe({ signal: eventAbort.signal })
      watcher = (async () => {
        try {
          for await (const event of events) {
            if (stopping) break
            if (event.type === 'server.connected') { ready = true; wake?.(); continue }
            if (event.type === 'session.deleted' && event.data?.sessionID === native.sessionID) throw fail('cancelled', 'Permission session deleted')
            if (event.type !== 'permission.replied' || event.data?.requestID !== request.id) continue
            const data = event.data
            if (data.sessionID !== native.sessionID || !['once', 'always', 'reject'].includes(data.reply)) throw fail('protocol', 'Correlated permission reply has invalid session/decision')
            if (decision && decision !== data.reply) throw fail('protocol', 'Conflicting permission settlement')
            decision = data.reply
            if (decision === 'reject') throw fail('denied', 'Native permission rejected')
            wake?.()
          }
          if (!stopping) stop(fail('stream', 'Native permission event stream ended before authorization'))
        } catch (error) { if (!stopping) stop(error instanceof LegacyPermissionError ? error : fail('stream', 'Native permission event stream failed', error)) }
      })()
      while (!ready) await wait(pause(confirmationIntervalMs))
      // Do not abort the HTTP mutation and pretend that server-side creation rolled back.
      submitted = true
      creation = Promise.resolve().then(() => client.permission.create(request)).then(result => { created = true; return result })
      const result = await wait(creation)
      if (result?.id !== request.id || !['allow', 'deny', 'ask'].includes(result.effect)) throw fail('protocol', 'Invalid native permission creation result')
      if (result.effect === 'deny') throw fail('denied', 'Native permission policy denied the request')
      if (result.effect === 'ask') {
        // Replied is emitted BEFORE commit. Require both decision and removal.
        for (;;) {
          const value = await wait(pending())
          if (decision && !value) break
          // Transport delivery may lag the native list. Absence alone never authorizes.
          // Keep waiting for a decision, stream failure or the bounded deadline.
          await wait(pause(confirmationIntervalMs))
        }
      } else {
        if (decision || await wait(pending())) throw fail('protocol', 'Policy-authorized result contradicts native pending state or reply')
      }
      await wait(attest(native))
      if (failure) throw failure
      completed = true
    } catch (error) {
      stop(error)
      let cleanupTimer
      const cleanup = async () => {
        if (!submitted) return
        // A lost/failed HTTP response does not prove that native creation failed.
        // Observe mutation settlement, then reconcile through independent controls.
        if (!created) await creation.catch(() => {})
        const value = await pending()
        if (!value) return
        try { await permission.reply({ sessionID: native.sessionID, requestID: request.id, decision: 'reject' }) }
        catch (cause) {
          // Another native decision or same-session batch rejection may have
          // won the race. Reconcile absence; never retry the mutation or grant.
          if (await pending()) throw cause
        }
        if (await pending()) throw fail('cleanup', 'Native rejection did not clear the owned permission')
      }
      try {
        await Promise.race([cleanup(), new Promise((_, reject) => {
          cleanupTimer = setTimeout(() => reject(fail('cleanup', 'Permission cleanup deadline exceeded; pending state is uncertain')), cleanupTimeoutMs)
        })])
      } catch (cause) {
        quarantine = fail('cleanup', 'Permission failure and native cleanup failure; binding quarantined', new AggregateError([error, cause]))
        op.cleanupError = quarantine
        throw quarantine
      } finally { clearTimeout(cleanupTimer) }
      throw error
    } finally {
      clearTimeout(timer)
      native.signal.removeEventListener('abort', cancellation)
      stopping = true
      eventAbort.abort()
      wake?.()
      // Public SharedEvents guarantees abort closes its subscriber. A broken
      // client violates the required capability; do not hang disposal forever.
      if (watcher) {
        let closeTimer
        try {
          await Promise.race([watcher, new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(fail('cleanup', 'Permission event subscription failed to close')), cleanupTimeoutMs)
          })])
        } catch (error) {
          quarantine = fail('cleanup', 'Permission event cleanup incomplete', failure ? new AggregateError([failure, error]) : error)
          op.cleanupError = quarantine
          throw quarantine
        }
        finally { clearTimeout(closeTimer) }
      }
    }
  }
  return Object.freeze({
    ask(context, input) {
      if (disposed) return Promise.reject(fail('disposed', 'Permission binding disposed'))
      if (quarantine) return Promise.reject(quarantine)
      const op = {}
      const job = run(context, input, op)
      op.job = job
      active.add(op)
      job.then(() => active.delete(op), () => active.delete(op))
      return job
    },
    async dispose() {
      disposed = true
      const owned = [...active]
      for (const op of owned) op.stop?.(fail('disposed', 'Permission binding disposed'))
      await Promise.allSettled(owned.map(op => op.job))
      const errors = [...new Set([quarantine, ...owned.map(op => op.cleanupError)].filter(Boolean))]
      if (errors.length) throw new AggregateError(errors, 'Permission binding cleanup incomplete')
    },
  })
}
