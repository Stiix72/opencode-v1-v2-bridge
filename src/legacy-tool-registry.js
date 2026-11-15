/**
 * Host-independent tool registry assembly for independently loaded V1 plugins.
 *
 * A V2 integration can use the returned immutable snapshot in its tool transform.
 * This module does not guess the V2 callback signature or mutate host state.
 */
import { translateLegacyTools } from './legacy-tools.js'
import { legacyPluginOwner } from './legacy-lifecycle.js'

export class LegacyToolRegistryError extends Error {
  constructor(message, { plugin, tool, cause } = {}) {
    super(message, { cause })
    this.name = 'LegacyToolRegistryError'
    this.plugin = plugin
    this.tool = tool
  }
}

function pluginLabel(plugin, index) {
  return plugin.id ?? plugin.target ?? `legacy-plugin-${index + 1}`
}

/**
 * Stage a complete tool catalog without touching the live V2 registry.
 * On a translation failure, the entire offending plugin is omitted.
 * On collisions, the later plugin is omitted (never silently overwritten).
 * The caller may supply the names of already registered native V2 tools.
 *
 * The returned snapshot is independent of subsequent mutations to source
 * plugin registry objects. Legacy execute callbacks are intentionally retained.
 */
export async function assembleLegacyToolRegistry(plugins, {
  nativeNames = [],
  convertSchema,
  makeContext,
} = {}) {
  if (!Array.isArray(plugins)) throw new TypeError('plugins must be an array')
  if (!Array.isArray(nativeNames) || nativeNames.some(name => typeof name !== 'string')) {
    throw new TypeError('nativeNames must be an array of strings')
  }
  const catalog = Object.create(null)
  const owners = new Map(nativeNames.map(name => [name, 'native-v2']))
  const failures = []
  const accepted = []

  for (const [index, plugin] of plugins.entries()) {
    let label = `legacy-plugin-${index + 1}`
    try {
      label = pluginLabel(plugin ?? {}, index)
      const registry = plugin?.hooks?.tool
      if (registry === undefined) {
        accepted.push({ plugin: label, tools: [] })
        continue
      }
      const lifetime = legacyPluginOwner(plugin).lifetime
      // Convert all schemas before publishing any tool from this plugin.
      const tools = await translateLegacyTools(registry, {
        convertSchema: convertSchema && ((schema, name) => convertSchema(schema, name, plugin)),
        makeContext: makeContext && ((invocation, name) => makeContext(invocation, name, plugin)),
        assertActive: lifetime.assertActive,
      })
      for (const name of Object.keys(tools)) {
        if (owners.has(name)) {
          throw new LegacyToolRegistryError(
            `Tool ${JSON.stringify(name)} from ${JSON.stringify(label)} conflicts with ${JSON.stringify(owners.get(name))}`,
            { plugin: label, tool: name },
          )
        }
      }
      for (const [name, descriptor] of Object.entries(tools)) {
        catalog[name] = descriptor
        owners.set(name, label)
      }
      accepted.push({ plugin: label, tools: Object.keys(tools) })
    } catch (cause) {
      failures.push({ plugin: label, error: cause })
    }
  }
  return Object.freeze({
    tools: Object.freeze(catalog),
    accepted: Object.freeze(accepted.map(item => Object.freeze({ ...item, tools: Object.freeze(item.tools) }))),
    failures: Object.freeze(failures.map(item => Object.freeze(item))),
  })
}

/**
 * Copy a validated, staged snapshot into a host-provided mutable tool map.
 * Fail before modifying anything if the map acquired a conflicting name.
 * The host integration must still convert descriptors to actual V2 definitions.
 */
export function applyLegacyToolSnapshot(snapshot, destination, toV2Definition) {
  if (!snapshot?.tools || typeof snapshot.tools !== 'object') throw new TypeError('invalid snapshot')
  if (!destination || typeof destination !== 'object') throw new TypeError('destination must be an object')
  if (typeof toV2Definition !== 'function') throw new TypeError('toV2Definition must be a function')
  const prepared = []
  for (const [name, descriptor] of Object.entries(snapshot.tools)) {
    if (name in destination) throw new LegacyToolRegistryError(`Tool ${JSON.stringify(name)} already exists in destination`, { tool: name })
    prepared.push([name, toV2Definition(descriptor, name)])
  }
  // This commit stage is synchronous; the caller owns the destination lifecycle.
  for (const [name, definition] of prepared) destination[name] = definition
  return destination
}
