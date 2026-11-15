/**
 * Reusable, opt-in V2 -> V1 event envelope translation.
 *
 * A named event is forwarded only if it has a registered validator. Unknown
 * events are skipped. No payload is cloned, rewritten or silently coerced.
 * Validators are caller-supplied contracts, not assertions that the live
 * OpenCode 2.0.27 runtime has been verified.
 */
export class V2EventMappingError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2EventMappingError'
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A conservative reusable validator for message.updated events. */
export function validateMessageUpdated(properties) {
  const info = properties.info
  return record(info) && typeof info.id === 'string' && info.id.length > 0 &&
    typeof info.role === 'string' && info.role.length > 0
}

/**
 * @param {Record<string, (properties: object) => boolean|void>} validators
 * @param {{onUnknown?: 'skip'|'reject'}} options
 */
export function createV2EventMapper(validators, { onUnknown = 'skip' } = {}) {
  if (!record(validators) || !Object.keys(validators).length) {
    throw new TypeError('Event validators must be a nonempty record')
  }
  if (onUnknown !== 'skip' && onUnknown !== 'reject') {
    throw new TypeError('onUnknown must be skip or reject')
  }
  const rules = new Map()
  for (const [name, validator] of Object.entries(validators)) {
    if (!name || typeof validator !== 'function') {
      throw new TypeError('Each event name needs a validator function')
    }
    rules.set(name, validator)
  }
  return function mapV2Event(value) {
    if (!record(value) || typeof value.type !== 'string' || !value.type) {
      throw new V2EventMappingError('V2 event must have a nonempty string type')
    }
    const validator = rules.get(value.type)
    if (!validator) {
      if (onUnknown === 'reject') throw new V2EventMappingError(`Unsupported event type: ${value.type}`)
      return null
    }
    if (!record(value.properties)) {
      throw new V2EventMappingError(`${value.type} requires object properties`)
    }
    let accepted
    try { accepted = validator(value.properties) }
    catch (cause) { throw new V2EventMappingError(`${value.type} validator failed`, cause) }
    if (accepted === false) throw new V2EventMappingError(`${value.type} payload failed validation`)
    if (accepted !== true && accepted !== undefined) {
      throw new V2EventMappingError(`${value.type} validator must return true, false, or undefined`)
    }
    return { type: value.type, properties: value.properties }
  }
}

/** A reusable event mapper preset; no plugin-specific behavior. */
export const mapV2MessageUpdated = createV2EventMapper({
  'message.updated': validateMessageUpdated,
})
