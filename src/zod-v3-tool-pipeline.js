/**
 * Opt-in Zod v3 tool integration. Schema conversion is performed before
 * registration; runtime parsing uses the ORIGINAL schema instance so that
 * legacy Zod semantics (including unknown-key stripping) remain authoritative.
 * No OpenCode host calls are made here.
 */
import { assembleLegacyToolRegistry } from './legacy-tool-registry.js'
import { convertZodV3ToJsonSchema } from './zod-v3-schema.js'
import { prepareV2Tools } from './v2-tool-registration.js'
import { makeV2ToolDefinition } from './v2-tool-definition.js'
import {isZodV3FieldMap,convertZodV3FieldMap}from'./zod-v3-field-map.js'
import { isZodV4FieldMap, convertZodV4FieldMap, parseZodV4FieldMap } from './zod-v4-field-map.js'

export class LegacyZodValidationError extends Error {
  constructor(name, cause) {
    super(`Legacy tool ${JSON.stringify(name)}: Zod argument validation failed`, { cause })
    this.name = 'LegacyZodValidationError'
  }
}

/**
 * Only convert Zod v3 schemas, and reject schemas that lack the original
 * parser. A structurally converted schema without parse() is insufficient to
 * guarantee legacy argument semantics.
 */
export function convertZodV3ToolSchema(schema) {
  if (isZodV4FieldMap(schema)) return convertZodV4FieldMap(schema)
  if (isZodV3FieldMap(schema)) return convertZodV3FieldMap(schema)
  if (typeof schema?.parse !== 'function' || !schema?._def || typeof schema._def.typeName !== 'string') {
    throw new TypeError('Expected a Zod v3 schema with a working parse() method')
  }
  return convertZodV3ToJsonSchema(schema)
}

/**
 * Produces staged V2 definitions without registering anything in the host.
 * Conversion failures remain per-plugin, as in assembleLegacyToolRegistry.
 * makeInvocation is required to supply the legacy session/workspace context.
 */
export async function prepareZodV3LegacyTools(plugins, {
  makeInvocation,
  makeContext,
  nativeNames = [],
  toolExposure = 'direct',
  permissionBinding,
} = {}) {
  if (!['direct', 'code-mode'].includes(toolExposure)) throw new TypeError('toolExposure must be direct or code-mode')
  if (permissionBinding && makeContext !== undefined) throw new TypeError('permissionBinding cannot be combined with makeContext; map paths in makeInvocation')
  if (typeof makeInvocation !== 'function') throw new TypeError('makeInvocation is required')
  const snapshot = await assembleLegacyToolRegistry(plugins, {
    nativeNames,
    convertSchema: convertZodV3ToolSchema,
    makeContext,
  })
  const prepared = await prepareV2Tools(snapshot, (descriptor, name) => {
    const base = makeV2ToolDefinition(descriptor, { makeInvocation, toolExposure, permissionBinding })
    // Parser is carried by the accepted descriptor; never rediscover it via
    // plugin labels, which may collide or be reused by rejected plugins.
    const parse = descriptor.parseInput
    if (typeof parse !== 'function') {
      throw new TypeError(`Accepted Zod v3 tool ${JSON.stringify(name)} has no parser`)
    }
    return Object.freeze({
      ...base,
      async execute(input, context) {
        let parsed = input
        if (parse) {
          try { parsed = await parse(input) }
          catch (cause) { throw new LegacyZodValidationError(name, cause) }
        }
        return base.execute(parsed, context)
      },
    })
  })
  return { snapshot, prepared }
}
