/** Opt-in diagnostic logger. Borrowed streams are never ended or destroyed. */
import { lifecycleTimeout, settleLegacyCleanup } from './legacy-lifecycle.js'

export class StderrLogError extends Error {
  constructor(code, message, cause, phase) {
    super(message, { cause })
    this.name = 'StderrLogError'
    this.code = code
    this.phase = phase
  }
}

export function createStderrLegacyLogger({ stream, write, lifecycleTimeoutMs } = {}) {
  const timeoutMs = lifecycleTimeout(lifecycleTimeoutMs)
  if (write !== undefined && typeof write !== 'function') throw new TypeError('write must be a function')
  if (write !== undefined && stream !== undefined) throw new TypeError('Choose stream or custom write, not both')
  const mode = write === undefined ? 'writable' : 'custom'
  if (mode === 'writable') {
    stream ??= process.stderr
    for (const key of ['write', 'on', 'prependListener', 'removeListener', 'listenerCount']) {
      if (typeof stream?.[key] !== 'function') throw new TypeError('Writable stream requires ' + key)
    }
  }
  let closed = false, active, blocked = false, terminalError, closing
  const records = new Set(), attached = new Set(), cleanupFaults = []
  const handlers = { error: onError, drain: onDrain, close: onClose }
  function detach(names = ['error', 'drain', 'close']) {
    const failures = []
    for (const name of names) if (attached.has(name)) {
      try { stream.removeListener(name, handlers[name]); attached.delete(name) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'stderr listener removal failed')
  }
  function attach() {
    for (const name of ['error', 'drain', 'close']) if (!attached.has(name)) {
      if (name === 'error') stream.prependListener(name, handlers[name])
      else stream.on(name, handlers[name])
      attached.add(name)
    }
  }
  function report(record) {
    if (!record.callReturned || record.reported) return
    if (record.failures.size) {
      record.reported = true
      const cause = [...record.failures][0]
      if (mode === 'custom') record.reject(cause)
      else {
        const error = new StderrLogError(record.code ?? 'STDERR_LOG_WRITE_FAILED',
          'stderr write failed: ' + (cause?.message ?? String(cause)), cause, record.phase)
        Object.defineProperty(error, 'cleanupDone', { value: record.done })
        record.reject(error)
      }
    } else if (record.callbackSeen) {
      record.reported = true
      record.resolve()
    }
  }
  function retire(record) {
    if (record.retiring || record.retired) return
    record.retiring = true
    // Callback-error retirement waits for the supported Writable error/close
    // notification, rather than guessing a delay or hiding a later event.
    const finish = () => {
      record.retired = true
      if (active === record) active = undefined
      records.delete(record)
      if (mode === 'writable') {
        try {
          if (closed || terminalError || !blocked) detach()
          else detach(['error']) // No pending write: do not intercept unrelated errors.
        } catch (error) { cleanupFaults.push(error); record.failures.add(error) }
      }
      const failures = [...record.failures]
      if (failures.length === 1) record.finishFailure(failures[0])
      else if (failures.length) record.finishFailure(new AggregateError(failures, 'stderr write and listener cleanup failed'))
      else record.finish()
    }
    if (mode === 'custom') finish()
    else queueMicrotask(finish)
  }
  function progress(record) {
    if (!record.callReturned || record.retired) return
    const complete = record.threw || record.closeSeen ||
      record.callbackSeen && (!record.callbackError || record.errorSeen)
    if (complete && !record.nonstandardPending) retire(record)
    report(record) // Retirement is queued before successful callers can write again.
  }
  function fail(record, error, phase, code) {
    record.failures.add(error)
    if (!record.phase) { record.phase = phase; record.code = code }
    if (mode === 'writable') terminalError ??= error
    progress(record)
  }
  function onError(error) {
    const record = active
    if (!record || record.retired || record.callbackSeen && !record.failures.size) {
      // Prepending our listener preserves the presence of external once listeners.
      // When this event does not belong to a pending write, preserve native
      // unhandled-error behavior instead of using logging as a blanket shield.
      if (stream.listenerCount('error') <= 1) throw error
      return
    }
    record.errorSeen = true
    fail(record, error, 'stream-error')
  }
  function onDrain() {
    blocked = false
    if (active) active.drainSeen = true
    else {
      try { detach() } catch (error) { cleanupFaults.push(error) }
    }
  }
  function onClose() {
    blocked = false
    const error = Object.assign(new Error('stderr stream closed before write completion'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    terminalError ??= error
    if (active) {
      active.closeSeen = true
      if (!active.callbackSeen) fail(active, error, 'stream-close')
      progress(active)
    } else {
      try { detach() } catch (failure) { cleanupFaults.push(failure) }
    }
  }
  function submit(line) {
    if (closed) return Promise.reject(new StderrLogError('STDERR_LOG_DISPOSED', 'stderr logger disposed', undefined, 'admission'))
    if (cleanupFaults.length || mode === 'writable' && (terminalError || stream.destroyed || stream.closed || stream.writableEnded || stream.errored)) {
      return Promise.reject(new StderrLogError('STDERR_LOG_UNAVAILABLE', 'stderr stream unavailable', terminalError ?? stream?.errored ?? cleanupFaults[0], 'admission'))
    }
    // No internal record queue: callers must await completion/capacity. Rejected
    // admissions are not written, retained, automatically retried or reordered.
    if (active || blocked || mode === 'writable' && stream.writableNeedDrain === true) {
      return Promise.reject(new StderrLogError('STDERR_LOG_CAPACITY', 'stderr logger busy or backpressured; record not submitted', undefined, 'admission'))
    }
    const record = { failures: new Set(), callReturned: false, callbackSeen: false, callbackError: false, errorSeen: false, closeSeen: false, drainSeen: false, reported: false, retired: false }
    const result = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject })
    record.result = result
    record.done = new Promise((resolve, reject) => { record.finish = resolve; record.finishFailure = reject })
    record.done.catch(() => {}) // Original rejecting completion remains inspectable.
    Object.defineProperty(result, 'cleanupDone', { value: record.done })
    active = record; records.add(record) // Before any supplied code can reenter cleanup.
    if (mode === 'custom') {
      try {
        const returned = write(line)
        record.callReturned = true
        if (returned && typeof returned.then === 'function') Promise.resolve(returned).then(() => {
          record.callbackSeen = true; progress(record)
        }, error => { record.callbackSeen = true; fail(record, error, 'custom-writer') })
        else { record.callbackSeen = true; progress(record) }
      } catch (error) { record.callReturned = true; record.threw = true; fail(record, error, 'custom-writer') }
      return result
    }
    try {
      attach()
      const value = stream.write(line, error => {
        if (record.callbackSeen || record.retired) return
        record.callbackSeen = true; record.callbackError = error != null
        if (error != null) fail(record, error, 'write-callback')
        progress(record)
      })
      record.callReturned = true
      if (value === false) blocked = !record.drainSeen
      else if (value !== true) {
        if (value && typeof value.then === 'function') {
          record.nonstandardPending = true
          Promise.resolve(value).then(() => { record.nonstandardPending = false; progress(record) },
            error => { record.nonstandardPending = false; fail(record, error, 'stream-contract') })
        }
        fail(record, new TypeError('Writable.write must return a boolean; use custom write for a function-defined completion contract'),
          'stream-contract', 'STDERR_LOG_STREAM_CONTRACT')
      }
      progress(record)
    } catch (error) { record.callReturned = true; record.threw = true; fail(record, error, 'write-call') }
    return result
  }
  const logger = request => {
    try {
      const body = request?.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Legacy log requires body object')
      const { service, level, message } = body
      if (typeof message !== 'string' || typeof service !== 'string' || typeof level !== 'string') throw new TypeError('Legacy log requires service, level, message strings')
      return submit(JSON.stringify({ service, level, message }) + '\n')
    } catch (error) { return Promise.reject(error) }
  }
  Object.defineProperties(logger, {
    mode: { value: mode, enumerable: true },
    pending: { get: () => records.size },
    dispose: { value: () => {
      if (!closing) {
        closed = true
        const pending = [...records]
        closing = settleLegacyCleanup([...pending.map(record => () => record.result), () => {
          const failures = [...cleanupFaults]
          if (mode === 'writable') { try { detach() } catch (error) { failures.push(error) } }
          blocked = false
          if (failures.length) throw new AggregateError([...new Set(failures)], 'stderr logger listener cleanup failed')
        }], {
          timeoutMs, label: 'stderr logger cleanup failed',
          labels: [...pending.map(() => mode === 'writable' ? 'stderr Writable completion and listener retirement' : 'stderr custom writer completion'), 'stderr logger listener release'],
          dependencies: [...pending.map(() => []), pending.map((_, index) => index)],
        })
      }
      return closing
    } },
  })
  return Object.freeze(logger)
}
