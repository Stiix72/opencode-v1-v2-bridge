/**
 * Offline V2 command registration boundary. The host must supply an exact
 * invocation decoder and an independently verified output-delivery function.
 * No command is registered until both are available. No model call is inferred.
 */
import { executeAndDeliverLegacyCommand } from './legacy-command-bridge.js'

export class V2CommandRegistrationError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2CommandRegistrationError'
  }
}

const validName = name => typeof name === 'string' && /^[a-zA-Z][\w.-]*$/.test(name)

function rejectPropertyAccessor(object, key) {
  let cursor = object
  while (cursor !== null) {
    const property = Object.getOwnPropertyDescriptor(cursor, key)
    if (property) {
      if (!Object.hasOwn(property, 'value')) {
        throw new V2CommandRegistrationError(`Accessor command property: ${key}`)
      }
      return
    }
    cursor = Object.getPrototypeOf(cursor)
  }
}

/**
 * `entries`: [{name, hook, description?}], where hook is a V1
 * command.execute.before callback. The host's command.transform editor accepts
 * {name, description, execute}, per the investigated V2 Promise API.
 *
 * `decode` receives the untouched V2 invocation and the registered command
 * name and MUST return {command, sessionID, arguments, ...}. In particular,
 * parsing the V2 `prompt` into arguments is intentionally left to the host.
 */
export function prepareV2LegacyCommands(entries, { decode, deliver } = {}) {
  if (typeof decode !== 'function' || typeof deliver !== 'function') {
    throw new V2CommandRegistrationError('Verified invocation decoder and output delivery are required')
  }
  if (!Array.isArray(entries)) throw new TypeError('Command entries must be an array')
  const names = new Set()
  const prepared = entries.map((entry, index) => {
    if (!entry || !validName(entry.name) || typeof entry.hook !== 'function') {
      throw new V2CommandRegistrationError(`Invalid command entry at index ${index}`)
    }
    if (names.has(entry.name)) throw new V2CommandRegistrationError(`Duplicate legacy command: ${entry.name}`)
    names.add(entry.name)
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      throw new V2CommandRegistrationError(`Invalid description for ${entry.name}`)
    }
    // Capture the validated handler and identity now. The caller owns `entry`
    // and may mutate it after registration (including during async decode).
    const { name, description, hook } = entry
    return {
      name,
      description,
      execute: async invocation => {
        const input = await decode(invocation, name)
        if (!input || input.command !== name || typeof input.sessionID !== 'string' || !input.sessionID) {
          throw new V2CommandRegistrationError(`Invocation decoder returned invalid identity for ${name}`)
        }
        if (invocation?.sessionID !== undefined && input.sessionID !== invocation.sessionID) {
          throw new V2CommandRegistrationError(`Session identity mismatch for ${name}`)
        }
        await executeAndDeliverLegacyCommand(hook, input, { deliver })
      },
    }
  })
  return prepared
}

/** Register all prepared commands in one V2 command.transform callback. */
export async function registerPreparedV2LegacyCommands(commandDomain, prepared) {
  if (typeof commandDomain?.transform !== 'function') {
    throw new V2CommandRegistrationError('V2 command.transform is required')
  }
  if (!Array.isArray(prepared) || Object.keys(prepared).length !== prepared.length) {
    throw new V2CommandRegistrationError('Expected dense prepared command definitions')
  }
  for (const entry of prepared) {
    if (entry && (typeof entry === 'object' || typeof entry === 'function')) {
      for (const key of ['name', 'execute', 'description']) rejectPropertyAccessor(entry, key)
    }
  }
  if (prepared.some(x => !x || !validName(x.name) || typeof x.execute !== 'function' ||
      (x.description !== undefined && typeof x.description !== 'string'))) {
    throw new V2CommandRegistrationError('Expected prepared command definitions')
  }
  if (!prepared.length) return null
  // Snapshot validated definitions for replay; caller-owned entries may mutate.
  const entries = prepared.map(({ name, description, execute }) => Object.freeze({ name, description, execute }))
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) {
    throw new V2CommandRegistrationError('Duplicate prepared legacy command names')
  }
  // Transform callbacks may replay on reload. Definitions must be immutable
  // and no legacy handler executes during registration.
  return commandDomain.transform(editor => {
    if (typeof editor?.add !== 'function') throw new V2CommandRegistrationError('V2 command editor.add is required')
    // Some hosts expose an editor.list() snapshot. If available, detect
    // collisions before adding ANY command. Never replace a native V2 command.
    // Hosts without list() still require a verified collision policy.
    if (editor.list !== undefined) {
      if (typeof editor.list !== 'function') throw new V2CommandRegistrationError('V2 command editor.list must be a function')
      const current = editor.list()
      if (!Array.isArray(current) || Object.keys(current).length !== current.length) {
        throw new V2CommandRegistrationError('V2 command editor.list returned invalid command definitions')
      }
      for (const item of current) {
        if (item && (typeof item === 'object' || typeof item === 'function')) rejectPropertyAccessor(item, 'name')
      }
      if (current.some(item => !item || typeof item.name !== 'string')) {
        throw new V2CommandRegistrationError('V2 command editor.list returned invalid command definitions')
      }
      const existing = new Set(current.map(item => item.name))
      const collision = entries.find(definition => existing.has(definition.name))
      if (collision) throw new V2CommandRegistrationError(`V2 command ${collision.name} already registered`)
    }
    for (const definition of entries) editor.add(definition)
  })
}

export async function registerV2LegacyCommands(commandDomain, entries, options = {}) {
  const prepared = prepareV2LegacyCommands(entries, options)
  return registerPreparedV2LegacyCommands(commandDomain, prepared)
}
