import { onceCleanup, settleLegacyCleanup } from './legacy-lifecycle.js'
const legacyEventBatches = new WeakMap()
/**
 * V1 event-hook subscription boundary for OpenCode V2 Promise plugins.
 *
 * The V1 handler expects { event: { type, properties } }. V2 event names and
 * payloads are NOT presumed equivalent. An explicit mapping function is
 * mandatory. It may return null to skip an event that has no V1 equivalent.
 *
 * A subscription is owned by this bridge and must be disposed on plugin unload.
 * Errors are surfaced through `done` and optional onError; never swallowed.
 *
 * Host integration remains unverified against a running OpenCode 2.0.27.
 */
export class LegacyEventBridgeError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'LegacyEventBridgeError'
  }
}

export function validateLegacyEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.type !== 'string' || !event.type ||
      !event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
    throw new LegacyEventBridgeError('Mapped V1 event requires nonempty type and object properties')
  }
  return event
}

/** Internal, opaque projection sequence; never a native event or RPC value.
 * All one/two envelopes are validated before any callback is admitted. Empty,
 * sparse, accessor-bearing and oversized arrays fail rather than partially emit.
 */
export function createLegacyEventBatch(values) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype ||
      values.length < 1 || values.length > 2 || Reflect.ownKeys(values).length !== values.length + 1) {
    throw new LegacyEventBridgeError('Legacy event batch must be a dense one-or-two-event array')
  }
  const events = []
  for (let i = 0; i < values.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(values, String(i))
    if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable) throw new LegacyEventBridgeError('Legacy event batch entries must be data')
    events.push(validateLegacyEvent(slot.value))
  }
  const token = Object.freeze(Object.create(null))
  legacyEventBatches.set(token, Object.freeze(events))
  return token
}

/**
 * @param {object} ctx - V2 Promise-plugin context
 * @param {(input: object) => Promise<void>} handler - V1 event hook
 * @param {{mapEvent: Function, onError?: Function, disposeMapper?: () => void, disposeTimeoutMs?: number}} options
 * @returns {Promise<{done: Promise<void>, dispose: () => Promise<void>} >}
 */
export async function registerLegacyEvents(ctx, handler, { mapEvent, onError, disposeMapper, disposeTimeoutMs = 2000 } = {}) {
  if (typeof ctx?.event?.subscribe !== 'function') {
    throw new LegacyEventBridgeError('V2 event.subscribe is unavailable')
  }
  if (typeof handler !== 'function') throw new TypeError('V1 event handler must be a function')
  if (typeof mapEvent !== 'function') throw new LegacyEventBridgeError('Explicit V2-to-V1 event mapper is required')
  if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function')
  if (disposeMapper !== undefined && typeof disposeMapper !== 'function') throw new TypeError('disposeMapper must be a function')
  if (!Number.isSafeInteger(disposeTimeoutMs) || disposeTimeoutMs < 1) {
    throw new TypeError('disposeTimeoutMs must be a positive integer')
  }

  const controller = new AbortController()
  // Ownership is explicit: existing shared mapEvent functions are never disposed.
  // disposeMapper is synchronous, so it cannot extend the stream timeout.
  let mapperClosed = false
  let callbacksRunning = 0
  let mapperCleanup = Promise.resolve()
  const closeMapper = () => {
    if (mapperClosed || callbacksRunning) return
    mapperClosed = true
    const result = disposeMapper?.()
    if (result && typeof result.then === 'function') {
      mapperCleanup = Promise.resolve(result)
      // Retain the unsupported asynchronous cleanup for explicit disposal.
      void mapperCleanup.catch(() => {})
      throw new LegacyEventBridgeError('disposeMapper must complete synchronously')
    }
  }
  let iterator
  const stopIterator = onceCleanup(() => iterator?.return?.())
  try {
    const stream = ctx.event.subscribe({ signal: controller.signal })
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new LegacyEventBridgeError('V2 event.subscribe did not return an async iterable')
    }
    iterator = stream[Symbol.asyncIterator]()
    if (!iterator || typeof iterator.next !== 'function') {
      throw new LegacyEventBridgeError('V2 event subscription returned an invalid iterator')
    }
  } catch (error) {
    controller.abort()
    // If subscription created an iterator but its contract is invalid,
    // request cleanup before propagating the original validation error.
    const tasks=[()=>stopIterator(),async()=>{
      let contractError
      try{closeMapper()}catch(failure){contractError=failure}
      const outcomes=await Promise.allSettled([mapperCleanup])
      const errors=[...(contractError?[contractError]:[]),...outcomes.filter(x=>x.status==='rejected').map(x=>x.reason)]
      if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,'Mapper setup cleanup failed')
    }]
    try { await settleLegacyCleanup(tasks,{timeoutMs:disposeTimeoutMs,label:'Event setup cleanup failed'}) }
    catch(cleanupError){const failure=new AggregateError([error,cleanupError],'Event setup and cleanup failed');if(cleanupError.cleanupDone)failure.cleanupDone=cleanupError.cleanupDone;throw failure}
    try { closeMapper() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Event setup and mapper cleanup failed') }
    throw error
  }

  let disposed = false
  let callbackFailure = false
  const consumer = (async () => {
    try {
      while (!disposed) {
        const item = await iterator.next()
        if (!item || typeof item !== 'object' || typeof item.done !== 'boolean') {
          throw new LegacyEventBridgeError('V2 event iterator.next returned an invalid iteration result')
        }
        if (item.done || disposed) break
        let mapped
        try { callbacksRunning++; mapped = await mapEvent(item.value) } catch (error) { callbackFailure = true; throw error } finally { callbacksRunning-- }
        if (disposed || mapped == null) continue
        let projected
        try {
          callbacksRunning++
          projected = legacyEventBatches.get(mapped) ?? [validateLegacyEvent(mapped)]
          for (const event of projected) validateLegacyEvent(event)
        } catch (error) { callbackFailure = true; throw error } finally { callbacksRunning-- }
        for (const event of projected) {
          // Each callback needs separate admission. Disposal/rejection after the
          // first event never retries it or admits the second as fake cleanup.
          if (disposed) break
          try { callbacksRunning++; await handler({ event: validateLegacyEvent(event) }) } catch (error) { callbackFailure = true; throw error } finally { callbacksRunning-- }
        }
      }
    } catch (error) {
      // A failed mapper, handler, or iterator terminates event processing.
      // Release the host subscription immediately, even if the caller never
      // explicitly disposes the bridge after observing `done` rejection.
      controller.abort()
      // An abort signal alone is not enough for iterators that require
      // return() to release resources. Never let cleanup mask the original
      // stream/callback failure or hang its propagation.
      if (!disposed && typeof iterator.return === 'function') {
        void stopIterator().catch(() => {})
      }
      // Disposal may suppress expected iterator-abort errors, but must not
      // erase a failure from a callback that was already running.
      if (!disposed || callbackFailure) throw error
    }
  })()
  const done = consumer.then(
    () => closeMapper(),
    error => {
      try { closeMapper() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Event consumer and mapper cleanup failed') }
      throw error
    },
  )
  // Install a rejection observer immediately, including when callers do not
  // await `done`. `done` itself still rejects for explicit diagnosis.
  void done.catch(error => {
    if (onError) {
      try {
        // Error reporters may be async. Observe their rejection without
        // masking the original failure exposed through `done`.
        void Promise.resolve(onError(error)).catch(() => {})
      } catch { /* synchronous reporter errors must not escape either */ }
    }
  })

  let closing
  const dispose = () => {
    if (closing) return closing
    disposed = true
    controller.abort()
    // Clear bounded mapper state even if a broken iterator never completes.
    let mapperError
    try { closeMapper() } catch (error) { mapperError = error }
    // Return/abort are requested immediately. Await completion to guarantee
    // no legacy callback is still running when dispose resolves.
    // Some async iterators (notably async generators) queue return() behind
    // an outstanding next(). If the host ignores abort, waiting for return()
    // and done forever would hang plugin unload. Surface a bounded failure.
    const shutdown = Promise.allSettled([stopIterator(),done]).then(async initial=>{
      const outcomes=[...initial,...await Promise.allSettled([mapperCleanup])]
      const errors=[...new Set([...outcomes.filter(x=>x.status==='rejected').map(x=>x.reason),...(mapperError?[mapperError]:[])])]
      if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,'Event consumer and iterator cleanup failed')
    })
    // Observe late shutdown failures even after the timeout has fired.
    void shutdown.catch(() => {})
    closing = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new LegacyEventBridgeError(
        `Event subscription did not stop within ${disposeTimeoutMs}ms after abort`,
      )), disposeTimeoutMs)
      shutdown.then(
        () => { clearTimeout(timeout); resolve() },
        error => { clearTimeout(timeout); reject(error) },
      )
    })
    Object.defineProperty(closing,'cleanupDone',{value:shutdown})
    return closing
  }
  return { done, dispose }
}
