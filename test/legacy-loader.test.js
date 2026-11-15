import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacyPlugin, initializeLegacyPlugin, loadLegacyPlugins, resolveLegacyTarget } from '../src/legacy-loader.js'

async function fixtures(run) {
  const root = await mkdtemp(join(tmpdir(), 'oc-v1-bridge-'))
  try {
    const put = async (name, contents) => { const path = join(root, name); await writeFile(path, contents); return path }
    await run({ root, put })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('imports legacy default function but does not invoke factory', async () => fixtures(async ({root, put}) => {
  const file = await put('legacy.mjs', 'export default async (ctx) => ({ tool: { x: { execute: async () => ctx.value } } })')
  const imported = await importLegacyPlugin('./legacy.mjs', {baseDirectory:root})
  assert.equal(imported.kind, 'legacy-function')
  const initialized = await initializeLegacyPlugin(imported, {value:'ok'})
  assert.equal(await initialized.hooks.tool.x.execute(), 'ok')
}))

test('supports object server export', async () => fixtures(async ({root, put}) => {
  await put('legacy.mjs', 'export default {id:"legacy", server: async () => ({event: async () => {}})}')
  const imported = await importLegacyPlugin('./legacy.mjs', {baseDirectory:root})
  assert.equal(imported.kind, 'legacy-object')
  assert.equal((await initializeLegacyPlugin(imported, {})).inventory.recognized[0], 'event')
}))

test('rejects native V2 definitions', async () => fixtures(async ({root, put}) => {
  await put('v2.mjs', 'export default {id:"v2", setup: async () => {}, server: async () => ({})}')
  await assert.rejects(importLegacyPlugin('./v2.mjs', {baseDirectory:root}), /Native V2 plugin/)
}))

test('fails closed on unsupported hooks', async () => fixtures(async ({root, put}) => {
  await put('legacy.mjs', 'export default async () => ({ "chat.params": async () => {} })')
  const imported = await importLegacyPlugin('./legacy.mjs', {baseDirectory:root})
  await assert.rejects(initializeLegacyPlugin(imported, {}), /Unsupported hooks: chat.params/)
}))

test('preserves factory errors with stage', async () => fixtures(async ({root, put}) => {
  await put('legacy.mjs', 'export default async () => { throw new Error("factory failed") }')
  const imported = await importLegacyPlugin('./legacy.mjs', {baseDirectory:root})
  await assert.rejects(initializeLegacyPlugin(imported, {}), error => error.stage === 'initialization' && /factory failed/.test(error.message))
}))

test('isolates plugin failures and duplicate targets', async () => fixtures(async ({root, put}) => {
  await put('a.mjs', 'export default async () => ({event: async () => {}})')
  await put('b.mjs', 'export default {id:"v2",setup: async () => {}}')
  const result = await loadLegacyPlugins(['./a.mjs', './b.mjs', './a.mjs'], () => ({}), {baseDirectory:root})
  assert.equal(result.loaded.length, 1)
  assert.equal(result.failures.length, 2)
  assert.equal(result.failures[1].error.stage, 'deduplication')
}))

test('does not install missing packages', async () => fixtures(async ({root}) => {
  await assert.rejects(resolveLegacyTarget('some-nonexistent-package-bridge-test', {baseDirectory:root}), /Cannot find module/)
}))

test('rejects ambiguous path and directory', async () => fixtures(async ({root}) => {
  await mkdir(join(root, 'dir'))
  await assert.rejects(resolveLegacyTarget('./dir', {baseDirectory:root}), /must be a file/)
  await assert.rejects(resolveLegacyTarget('..\\something', {baseDirectory:root}), /Ambiguous target/)
}))
