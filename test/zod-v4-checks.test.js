import test from 'node:test'
import assert from 'node:assert/strict'
import { convertZodV4FieldMap } from '../src/zod-v4-field-map.js'

test('Zod v4 field conversion fails closed on checks it cannot represent', () => {
  const field = { def: { type: 'string', checks: [{ kind: 'min', value: 10 }] }, parse: value => value, '~standard': { vendor: 'zod' } }
  assert.throws(() => convertZodV4FieldMap({ description: field }), /Unsupported Zod v4 checks/)
})
