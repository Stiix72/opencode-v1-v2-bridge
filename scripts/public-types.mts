import bridge, { createServerPlugin, validateServerOptions, type ServerConfiguration } from 'opencode-v1-bridge'
import server from 'opencode-v1-bridge/server'

const config = {
  version: 1,
  targets: [{ id: 'example', module: './plugin.mjs', sessionCreated: true }],
  events: 'session-lifecycle',
  clientOptions: { responseStyle: 'data', throwOnError: true },
} satisfies ServerConfiguration

const validated: Readonly<ServerConfiguration> = validateServerOptions(config)
const setup: typeof bridge.setup = createServerPlugin().setup
const sameEntrypoint: typeof bridge = server
void [validated, setup, sameEntrypoint]

// @ts-expect-error The public entrypoint has no toast profile.
const unsupported: ServerConfiguration = { ...config, toast: 'rpc' }
void unsupported
