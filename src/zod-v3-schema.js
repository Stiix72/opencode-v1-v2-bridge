/**
 * Conservative conversion of the supported *structural subset* of Zod v3
 * into JSON Schema. No Zod runtime dependency is required.
 *
 * This intentionally rejects transforms, effects, refinements, coercion,
 * unknown checks and unknown Zod types: dropping those constraints would
 * silently broaden a tool's accepted input. It does not replace Zod.parse().
 */
export class ZodV3ConversionError extends Error {
  constructor(path, reason) {
    super(`Zod v3 schema at ${path}: ${reason}`)
    this.name = 'ZodV3ConversionError'
  }
}

const fail = (path, reason) => { throw new ZodV3ConversionError(path, reason) }
const natural = value => Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value)


function isOptional(node) {
  const kind = node?._def?.typeName
  return kind === 'ZodOptional' || (kind === 'ZodNullable' && isOptional(node._def.innerType))
}

function convert(node, path, seen) {
  if (!node || typeof node !== 'object' || !node._def || typeof node._def !== 'object') fail(path, 'not a Zod v3 schema')
  if (seen.has(node)) fail(path, 'recursive schemas are not supported')
  seen.add(node)
  try {
    const def = node._def
    if (def.coerce === true) fail(path, 'coercion cannot be preserved by JSON Schema')
    switch (def.typeName) {
      case 'ZodOptional': return convert(def.innerType, path, seen)
      case 'ZodNullable': return { anyOf: [convert(def.innerType, path, seen), { type: 'null' }] }
      case 'ZodDefault': fail(path, 'defaults require runtime parsing and cannot be preserved')
      case 'ZodEffects': fail(path, 'effects/refinements/transforms cannot be preserved')
      case 'ZodString': {
        const out = { type: 'string' }
        for (const check of def.checks ?? []) {
          if (['min', 'max', 'length'].includes(check.kind) && !natural(check.value)) fail(path, 'invalid string length constraint')
          switch (check.kind) {
            case 'min': out.minLength = Math.max(out.minLength ?? -Infinity, check.value); break
            case 'max': out.maxLength = Math.min(out.maxLength ?? Infinity, check.value); break
            case 'length': out.minLength = Math.max(out.minLength ?? -Infinity, check.value); out.maxLength = Math.min(out.maxLength ?? Infinity, check.value); break
            case 'email':
            case 'url':
            case 'uuid': {
              const format = check.kind === 'url' ? 'uri' : check.kind
              if (out.format !== undefined && out.format !== format) fail(path, 'multiple string formats cannot be represented safely')
              out.format = format; break
            }
            case 'regex': {
              if (!(check.regex instanceof RegExp) || check.regex.flags || out.pattern !== undefined) fail(path, 'regex flags or multiple regex constraints are not representable')
              out.pattern = check.regex.source; break
            }
            default: fail(path, `unsupported string check ${String(check.kind)}`)
          }
        }
        if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) fail(path, 'conflicting string length constraints')
        return out
      }
      case 'ZodNumber': {
        const out = { type: 'number' }
        for (const check of def.checks ?? []) {
          if (['min', 'max', 'multipleOf'].includes(check.kind) && !finite(check.value)) fail(path, 'invalid numeric constraint')
          if (['min', 'max'].includes(check.kind) && typeof check.inclusive !== 'boolean') fail(path, 'numeric bound requires an explicit inclusive flag')
          if (check.kind === 'multipleOf' && check.value <= 0) fail(path, 'multipleOf must be positive')
          switch (check.kind) {
            case 'int': out.type = 'integer'; break
            case 'min': {
              const previous = out.exclusiveMinimum ?? out.minimum ?? -Infinity
              if (check.value > previous || (check.value === previous && !check.inclusive)) {
                delete out.minimum; delete out.exclusiveMinimum
                out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value
              }
              break
            }
            case 'max': {
              const previous = out.exclusiveMaximum ?? out.maximum ?? Infinity
              if (check.value < previous || (check.value === previous && !check.inclusive)) {
                delete out.maximum; delete out.exclusiveMaximum
                out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value
              }
              break
            }
            case 'multipleOf':
              if (out.multipleOf !== undefined && out.multipleOf !== check.value) fail(path, 'multiple multipleOf constraints cannot be represented safely')
              out.multipleOf = check.value; break
            default: fail(path, `unsupported number check ${String(check.kind)}`)
          }
        }
        const lower = out.exclusiveMinimum ?? out.minimum
        const upper = out.exclusiveMaximum ?? out.maximum
        if (lower !== undefined && upper !== undefined &&
            (lower > upper || (lower === upper && (out.exclusiveMinimum !== undefined || out.exclusiveMaximum !== undefined)))) {
          fail(path, 'conflicting numeric bounds')
        }
        return out
      }
      case 'ZodBoolean': return { type: 'boolean' }
      case 'ZodLiteral': {
        if (!['string', 'number', 'boolean'].includes(typeof def.value) && def.value !== null) fail(path, 'unsupported literal')
        if (typeof def.value === 'number' && !finite(def.value)) fail(path, 'non-finite literal')
        return { const: def.value }
      }
      case 'ZodEnum': {
        if (!Array.isArray(def.values) || def.values.length === 0 || !def.values.every(x => typeof x === 'string') || new Set(def.values).size !== def.values.length) fail(path, 'invalid enum')
        return { type: 'string', enum: [...def.values] }
      }
      case 'ZodArray': {
        const out = { type: 'array', items: convert(def.type, `${path}[]`, seen) }
        for (const [kind, bound] of [['minLength', def.minLength], ['maxLength', def.maxLength], ['exactLength', def.exactLength]]) {
          if (bound != null && (!bound || typeof bound !== 'object' || !natural(bound.value))) fail(path, `invalid array ${kind}`)
        }
        if (def.minLength) out.minItems = def.minLength.value
        if (def.maxLength) out.maxItems = def.maxLength.value
        if (def.exactLength) {
          if ((out.minItems !== undefined && def.exactLength.value < out.minItems) || (out.maxItems !== undefined && def.exactLength.value > out.maxItems)) fail(path, 'conflicting array length constraints')
          out.minItems = out.maxItems = def.exactLength.value
        }
        if (out.minItems !== undefined && out.maxItems !== undefined && out.minItems > out.maxItems) fail(path, 'conflicting array length constraints')
        return out
      }
      case 'ZodObject': {
        if (!['strip', 'strict'].includes(def.unknownKeys) || def.catchall?._def?.typeName !== 'ZodNever' && def.catchall !== undefined) {
          fail(path, 'passthrough/catchall semantics require additional validation')
        }
        const shape = typeof def.shape === 'function' ? def.shape() : def.shape
        if (!shape || typeof shape !== 'object') fail(path, 'missing object shape')
        const properties = {}
        const required = []
        for (const [key, child] of Object.entries(shape)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, `unsafe property ${key}`)
          properties[key] = convert(child, `${path}.${key}`, seen)
          // Zod v3 .isOptional() can invoke parsing/defaults. Only use structural wrappers.
          if (!isOptional(child)) required.push(key)
        }
        const out = { type: 'object', properties, additionalProperties: false }
        if (required.length) out.required = required
        return out
      }
      default: fail(path, `unsupported Zod type ${String(def.typeName)}`)
    }
  } finally { seen.delete(node) }
}

/** Only intended for identified Zod v3 _def nodes, not arbitrary objects. */
export function convertZodV3ToJsonSchema(schema) {
  const result = convert(schema, '$', new Set())
  if (result.type !== 'object') fail('$', 'tool arguments must be an object schema')
  return result
}
