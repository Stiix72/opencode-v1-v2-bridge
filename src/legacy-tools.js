/**
 * Host-independent legacy tool translation. Produces descriptors for a V2
 * registrar; does NOT claim to register them with OpenCode 2.0.27.
 * Schema conversion is explicit to avoid treating Zod v3 as Standard Schema.
 */
import { createLegacyToolContext } from './legacy-context.js'
import { claimToolMetadata, invokeToolMetadata } from './legacy-live-metadata.js'
import {isFieldMap,snapshotFieldMap,createFieldMapParser}from'./zod-field-map.js'

export class LegacyToolConversionError extends Error {
  constructor(tool, message, cause) {
    super(`Legacy tool ${JSON.stringify(tool)}: ${message}`, { cause })
    this.name = 'LegacyToolConversionError'
    this.tool = tool
  }
}

function schemaIsJSON(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    (typeof value.type === 'string' || typeof value.$ref === 'string' ||
      Array.isArray(value.anyOf) || Array.isArray(value.oneOf) || Array.isArray(value.allOf))
}
function schemaIsStandard(value) {
  return value && typeof value === 'object' && value['~standard'] &&
    typeof value['~standard'].validate === 'function'
}

/**
 * Convert a legacy schema without importing an arbitrary Zod version.
 * A caller may supply a converter bound to the legacy package's Zod version.
 * In particular, Zod v3 must not be passed through as Standard Schema.
 */
export async function convertLegacySchema(schema, name, convertSchema) {
  // Recent V3 compatibility builds also expose ~standard. They still require
  // the explicit converter; the marker must not bypass structural policy.
  const v3=typeof schema?._def?.typeName==='string'
  if (!v3 && (schemaIsJSON(schema) || schemaIsStandard(schema))) return schema
  if (typeof convertSchema !== 'function') {
    throw new LegacyToolConversionError(name, 'schema is neither JSON Schema nor Standard Schema; supply a verified converter')
  }
  let converted
  try { converted = await convertSchema(schema, name) }
  catch (error) { throw new LegacyToolConversionError(name, 'schema converter failed', error) }
  if (!schemaIsJSON(converted) && !schemaIsStandard(converted)) {
    throw new LegacyToolConversionError(name, 'schema converter returned an unsupported representation')
  }
  return converted
}

function checkName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new LegacyToolConversionError(name, 'invalid tool name')
}

/** Own progress work started by this invocation, including V1 void-style calls.
 * No resource handle is acquired here: progress is a borrowed host operation.
 * The activation's existing lifetime/deadline owns this whole execution. */
async function executeWithProgress(execute, args, context, name, assertActive) {
  const pending = new Set(), failures = []
  const metadataOwner = Symbol('legacy tool metadata invocation')
  let accepting = true, result, executionError, executionFailed = false
  const ownedContext = Object.freeze({
    ...context,
    metadata(...values) {
      if (!accepting) throw new LegacyToolConversionError(name, 'ToolContext.metadata called after execution completed')
      let value
      try { assertActive(); value = invokeToolMetadata(context.metadata, this, values, assertActive, metadataOwner) }
      catch (error) { failures.push(error); throw error }
      const operation = Promise.resolve(value)
      pending.add(operation)
      // Observe immediately even if the V1 callback discards its void result.
      // Keep the original rejection visible to callers who do await it.
      operation.then(
        () => { pending.delete(operation) },
        error => { pending.delete(operation); failures.push(error) },
      )
      return value === undefined ? undefined : operation
    },
  })
  try { assertActive(); claimToolMetadata(context.metadata, metadataOwner); result = await execute(args, ownedContext) }
  catch (error) { executionFailed = true; executionError = error }
  finally { accepting = false }
  // No new progress can enter after the callback settles. Never call cancel,
  // close or dispose on the borrowed host operation; wait for its real outcome.
  await Promise.allSettled(pending)
  const errors = executionFailed ? [executionError] : []
  for (const error of failures) if (!errors.includes(error)) errors.push(error)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Legacy tool ' + JSON.stringify(name) + ': execution and progress failed')
  return result
}

/**
 * The adapter keeps the original execute callback and arguments unchanged.
 * V2 invocation must be translated into the V1 tool context by the host caller.
 * Missing required context values are rejected rather than fabricated.
 */
export async function translateLegacyTools(registry, {
  convertSchema,
  makeContext,
  assertActive = () => {},
} = {}) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new TypeError('legacy tool registry must be an object')
  if (makeContext !== undefined && typeof makeContext !== 'function') throw new TypeError('makeContext must be a function')
  if (typeof assertActive !== 'function') throw new TypeError('assertActive must be a function')
  const translated = Object.create(null)
  for (const [name, tool] of Object.entries(registry)) {
    checkName(name)
    if (!tool || typeof tool !== 'object' || typeof tool.execute !== 'function') {
      throw new LegacyToolConversionError(name, 'missing execute callback')
    }
    if (!Object.hasOwn(tool, 'args')) throw new LegacyToolConversionError(name, 'missing args schema')
    const args=tool.args
    if(args&&typeof args==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(args))){
      for(const key of Reflect.ownKeys(args)){
        const d=Object.getOwnPropertyDescriptor(args,key)
        if(typeof key!=='string'||!d||!Object.hasOwn(d,'value')||!d.enumerable)throw new LegacyToolConversionError(name,'Accessor/symbol/non-enumerable args schema')
      }
    }
    const raw=isFieldMap(args,3)||isFieldMap(args,4)
    const schema=raw?snapshotFieldMap(args):args
    // Capture parser identities before a converter yields to caller code.
    const parseInput=raw?createFieldMapParser(schema):typeof args?.parse==='function'?args.parse.bind(args):undefined
    const inputSchema = await convertLegacySchema(schema, name, convertSchema)
    const execute = tool.execute.bind(tool)
    translated[name] = Object.freeze({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema,
      // Bind the original parser to the accepted descriptor itself. Labels are
      // diagnostic only and cannot safely identify a plugin's schema.
      parseInput,
      async execute(args, invocation) {
        const supplied = makeContext ? await makeContext(invocation, name) : invocation
        // createLegacyToolContext enforces required identity, paths and capabilities.
        const legacyContext = createLegacyToolContext(supplied)
        // Final result/after hooks cannot overtake this invocation's progress.
        // Result conversion remains the responsibility of the V2 mapper.
        return executeWithProgress(execute, args, legacyContext, name, assertActive)
      },
    })
  }
  return translated
}
