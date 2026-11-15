import assert from 'node:assert/strict'
import test from 'node:test'
import bridge, { createServerPlugin, ServerConfigurationError, validateServerOptions } from 'opencode-v1-bridge'
import server from 'opencode-v1-bridge/server'

test('package entrypoints resolve to the same public server plugin', () => {
  assert.equal(bridge, server)
  assert.equal(createServerPlugin().id, bridge.id)
  assert.equal(typeof bridge.setup, 'function')
})

test('the public validator defaults to direct tools and snapshots target options', () => {
  const input = { version: 1, targets: [{ id: 'example', module: './plugin.mjs', options: { enabled: true } }] }
  const validated = validateServerOptions(input)
  input.targets[0].options.enabled = false
  assert.equal(validated.toolExposure, 'direct')
  assert.equal(validated.targets[0].options.enabled, true)
  assert.ok(Object.isFrozen(validated.targets[0].options))
})

test('toast is outside the public server configuration', () => {
  assert.throws(() => validateServerOptions({
    version: 1, targets: [{ id: 'example', module: './plugin.mjs' }], toast: 'rpc',
  }), ServerConfigurationError)
})

test('creation events require their explicit lifecycle profile', () => {
  const input = { version: 1, targets: [{ id: 'example', module: './plugin.mjs', sessionCreated: true }] }
  assert.throws(() => validateServerOptions(input), ServerConfigurationError)
  assert.equal(validateServerOptions({ ...input, events: 'session-lifecycle' }).targets[0].sessionCreated, true)
})
