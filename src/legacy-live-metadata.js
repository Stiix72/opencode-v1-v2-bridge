/** Explicit reduced live-data capability. Not the historical V1 part lifecycle. */
import { UnsupportedLegacyAPIError } from './legacy-context.js'

// Capability identities and one-invocation claims only; no payload/session state or work queues.
const bindings = new WeakMap()
const invalid = message => new TypeError('ToolContext.metadata live-json: ' + message)

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function data(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw invalid(key + ' must be an own data property')
  return descriptor
}
function snapshot(values) {
  if (values.length !== 1 || !record(values[0])) throw invalid('exactly one plain argument record is required')
  const input = values[0], title = data(input, 'title')
  if (title?.value !== undefined) {
    if (typeof title.value !== 'string') throw invalid('title must be omitted or undefined; other V1 title types are invalid')
    throw new UnsupportedLegacyAPIError('ToolContext.metadata.title (live-json has no independent title field)')
  }
  const metadata = data(input, 'metadata')
  if (!metadata || metadata.value === undefined) {
    throw new UnsupportedLegacyAPIError('ToolContext.metadata.metadata (live-json requires a record; absent metadata cannot be projected)')
  }
  // Per-submission snapshots preserve shared references, reject cycles, and never
  // use getters, source toJSON, JSON normalization, or a validation-to-use reread.
  const ancestors = new Set(), copies = new WeakMap()
  function copy(value, root = false) {
    if (!root) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid('numbers must be finite and must not be negative zero')
        return value
      }
    }
    if (value === null || typeof value !== 'object') throw invalid('only JSON data values are supported; metadata must be a record')
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (root && array || (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null)) {
      throw invalid('metadata must be a plain record; nested values must be plain records or arrays')
    }
    if (ancestors.has(value)) throw invalid('circular data is unsupported')
    if (copies.has(value)) return copies.get(value)
    const keys = Reflect.ownKeys(value), length = array ? Object.getOwnPropertyDescriptor(value, 'length') : undefined
    if (array && (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1)) {
      throw invalid('arrays must be dense and have no extra properties')
    }
    const output = array ? [] : {}
    ancestors.add(value); copies.set(value, output)
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value)) {
        throw invalid('accessors, symbol/nonenumerable keys, sparse arrays and array properties are unsupported')
      }
      Object.defineProperty(output, key, { value: copy(descriptor.value), enumerable: true, writable: true, configurable: true })
    }
    ancestors.delete(value)
    return output
  }
  return copy(metadata.value, true)
}
function deliver(progress, receiver, values, assertActive) {
  const payload = snapshot(values)
  // Proxy/descriptor inspection may reenter activation cleanup. Admission must
  // still hold immediately before the one native operation is started.
  assertActive()
  const operation = Reflect.apply(progress, receiver, [payload])
  const then = operation !== null && ['object', 'function'].includes(typeof operation) ? operation.then : undefined
  if (typeof then !== 'function') throw invalid('native progress capability must return Promise<void>')
  // Capture then once; do not change the default callback's return contract.
  return new Promise((resolve, reject) => Reflect.apply(then, operation, [value => {
    if (value !== undefined) reject(invalid('native progress capability must fulfill with undefined'))
    else resolve()
  }, reject]))
}

/**
 * Opt in inside makeInvocation for each native invocation:
 * metadata: createToolMetadataBinding({profile:'live-json', progress:ctx.progress})
 * The caller supplies the real same-invocation progress capability. No endpoint,
 * location or context is inferred. Lifetime and pending work stay with the
 * translated executor. Return this exact binding as metadata; direct calls,
 * producer wrappers and .bind() are unsupported because they hide ownership.
 * A binding is permanently claimed by its first translated invocation; create
 * a fresh binding for each native invocation, including after reactivation.
 */
export function createToolMetadataBinding(options) {
  if (!record(options)) throw invalid('binding options must be a plain record')
  const captured = Object.create(null)
  for (const key of Reflect.ownKeys(options)) {
    if (!['profile', 'progress'].includes(key)) throw invalid('unknown binding option')
    const descriptor = data(options, key)
    if (!descriptor) throw invalid('binding option disappeared during inspection')
    captured[key] = descriptor.value
  }
  const { profile, progress } = captured
  if (profile !== 'live-json') throw invalid('profile must be explicitly live-json')
  if (typeof progress !== 'function') throw new UnsupportedLegacyAPIError('ToolContext.metadata.live-json.progress')
  const callback = function () { throw new UnsupportedLegacyAPIError('ToolContext.metadata.live-json (requires the exact binding in a translated invocation)') }
  bindings.set(callback, { progress, owner: undefined })
  return Object.freeze(callback)
}

/** @internal Claim even an unused binding before entering a translated tool body. */
export function claimToolMetadata(callback, owner) {
  const binding = bindings.get(callback)
  if (!binding) return
  if (typeof owner !== 'symbol' || binding.owner !== undefined && binding.owner !== owner) {
    throw new UnsupportedLegacyAPIError('ToolContext.metadata.live-json (binding belongs to another invocation)')
  }
  binding.owner = owner
}

/** @internal Keep ordinary callbacks exactly unchanged; scoped tools add their admission guard. */
export function invokeToolMetadata(callback, receiver, values, assertActive, owner) {
  const binding = bindings.get(callback)
  if (!binding) return Reflect.apply(callback, receiver, values)
  claimToolMetadata(callback, owner)
  return deliver(binding.progress, receiver, values, assertActive)
}
