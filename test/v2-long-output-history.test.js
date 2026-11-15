import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommandOutputTuiCompanion } from '../src/v2-rpc-command-output.js'

test('multiple long outputs in the same session remain accessible, while other sessions stay isolated', async () => {
  let receive, slot
  const toasts = []
  const companion = createCommandOutputTuiCompanion({
    maxToastLength: 3,
    renderLongOutput: data => !data ? undefined : (data?.history ?? (data ? [{ command: data.command, text: data.text }] : [])).map(item => `/${item.command}\n${item.text}`).join('\n\n'),
  })
  const cleanup = companion.setup({
    client: { rpc: () => ({ events: { on: (_, cb) => { receive = cb; return () => {} } } }) },
    ui: {
      toast: { show: toast => toasts.push(toast) },
      slot: value => { slot = value; return () => {} },
      panel: { open: () => true },
      router: { current: () => ({ type: 'session', sessionID: 'one' }) },
    },
  })
  await receive({ data: { sessionID: 'one', command: 'personality', text: 'first output' } })
  await receive({ data: { sessionID: 'two', command: 'mood', text: 'other session' } })
  await receive({ data: { sessionID: 'one', command: 'mood', text: 'second output' } })
  const panel = sessionID => slot.render({ name: 'opencode-v1-bridge-output', sessionID })
  assert.equal(panel('one'), '/personality\nfirst output\n\n/mood\nsecond output')
  assert.equal(panel('two'), '/mood\nother session')
  assert.equal(toasts.length, 3)
  cleanup()
  assert.equal(panel('one'), undefined)
})
