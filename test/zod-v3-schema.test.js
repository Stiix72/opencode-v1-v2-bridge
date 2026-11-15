import test from 'node:test'
import assert from 'node:assert/strict'
import { convertZodV3ToJsonSchema as convert, ZodV3ConversionError } from '../src/zod-v3-schema.js'
const z = (typeName, extras = {}) => ({ _def: { typeName, ...extras } })
const obj = shape => z('ZodObject', { shape: () => shape, unknownKeys: 'strip', catchall: z('ZodNever') })
test('converts nested Zod v3 structural arguments and required keys', () => {
  const schema = obj({ mood: z('ZodEnum', { values: ['happy', 'calm'] }), detail: z('ZodOptional', { innerType: z('ZodString', { checks: [{ kind: 'min', value: 2 }] }) }), count: z('ZodNumber', { checks: [{ kind: 'int' }, { kind: 'min', value: 1, inclusive: true }] }), enabled: z('ZodBoolean') })
  assert.deepEqual(convert(schema), { type: 'object', properties: { mood: { type: 'string', enum: ['happy', 'calm'] }, detail: { type: 'string', minLength: 2 }, count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } }, additionalProperties: false, required: ['mood', 'count', 'enabled'] })
})
test('supports arrays and nullable values', () => {
  const result = convert(obj({ values: z('ZodArray', { type: z('ZodNullable', { innerType: z('ZodString') }), minLength: { value: 1 } }) }))
  assert.deepEqual(result.properties.values, { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] }, minItems: 1 })
})
test('rejects default values, effects, unknown checks and coercion', () => {
  for (const child of [z('ZodDefault', { innerType: z('ZodString'), defaultValue: () => 'x' }), z('ZodEffects', { schema: z('ZodString') }), z('ZodString', { checks: [{ kind: 'startsWith', value: 'a' }] }), z('ZodNumber', { coerce: true })]) {
    assert.throws(() => convert(obj({ x: child })), ZodV3ConversionError)
  }
})
test('rejects catchall, passthrough and recursion', () => {
  assert.throws(() => convert(z('ZodObject', { shape: () => ({}), unknownKeys: 'passthrough', catchall: z('ZodNever') })), /passthrough/)
  const circular = obj({})
  circular._def.shape = () => ({ self: circular })
  assert.throws(() => convert(circular), /recursive/)
})
test('rejects unsupported Zod types and non-object roots', () => {
  assert.throws(() => convert(obj({ x: z('ZodUnion') })), /unsupported Zod type/)
  assert.throws(() => convert(z('ZodString')), /tool arguments must be an object/)
})
test('does not execute Zod defaults or effects', () => {
  let invoked = 0
  const child = z('ZodDefault', { innerType: z('ZodString'), defaultValue: () => { invoked++; return 'bad' } })
  assert.throws(() => convert(obj({ x: child })), /defaults/)
  assert.equal(invoked, 0)
})

test('nullable optional fields remain optional', () => {
  const result = convert(obj({ x: z('ZodNullable', { innerType: z('ZodOptional', { innerType: z('ZodString') }) }) }))
  assert.equal(result.required, undefined)
})
test('audit: repeated string minimum checks retain strongest bound', () => {
  assert.equal(convert(obj({x:z('ZodString',{checks:[{kind:'min',value:8},{kind:'min',value:2}]})})).properties.x.minLength,8)
})
test('audit: repeated number maximum checks retain strongest bound', () => {
  assert.equal(convert(obj({x:z('ZodNumber',{checks:[{kind:'max',value:3,inclusive:true},{kind:'max',value:9,inclusive:true}]})})).properties.x.maximum,3)
})
test('audit: multiple regex checks cannot silently lose constraints', () => {
  assert.throws(()=>convert(obj({x:z('ZodString',{checks:[{kind:'regex',regex:/a/},{kind:'regex',regex:/b/}]})})),ZodV3ConversionError)
})
test('audit: repeated multipleOf checks must not discard an earlier constraint', () => {
  assert.throws(() => convert(obj({ x: z('ZodNumber', { checks: [{ kind: 'multipleOf', value: 2 }, { kind: 'multipleOf', value: 3 }] }) })), ZodV3ConversionError)
})
test('audit: exact array length must not weaken existing minimum', () => {
  assert.throws(() => convert(obj({ x: z('ZodArray', { type: z('ZodString'), minLength: { value: 5 }, exactLength: { value: 2 } }) })), ZodV3ConversionError)
})
test('audit: non-finite number check bounds cannot enter JSON Schema', () => {
  assert.throws(() => convert(obj({ x: z('ZodNumber', { checks: [{ kind: 'min', value: Infinity, inclusive: true }] }) })), ZodV3ConversionError)
})
test('audit: non-finite numeric literals cannot enter JSON Schema', () => {
  assert.throws(() => convert(obj({ x: z('ZodLiteral', { value: NaN }) })), ZodV3ConversionError)
})
test('audit: invalid string length bounds cannot enter JSON Schema', () => {
  assert.throws(() => convert(obj({ x: z('ZodString', { checks: [{ kind: 'min', value: -2 }] }) })), ZodV3ConversionError)
})

test('audit: conflicting string formats cannot silently overwrite earlier format', () => {
  assert.throws(() => convert(obj({ x: z('ZodString', { checks: [{kind:'email'}, {kind:'uuid'}] }) })), ZodV3ConversionError)
})
test('audit: incompatible string length bounds must not produce an impossible schema', () => {
  assert.throws(() => convert(obj({ x: z('ZodString', { checks: [{kind:'min',value:8}, {kind:'max',value:2}] }) })), ZodV3ConversionError)
})
test('audit: incompatible array min/max bounds must be rejected', () => {
  assert.throws(() => convert(obj({ x: z('ZodArray', {type:z('ZodString'), minLength:{value:8}, maxLength:{value:2}}) })), ZodV3ConversionError)
})
test('audit: unknown object key policy must not silently become strip', () => {
  assert.throws(() => convert(z('ZodObject', {shape:()=>({}), unknownKeys:'unrecognized', catchall:z('ZodNever')})), ZodV3ConversionError)
})
test('audit: empty or duplicate enum options must be rejected', () => {
  assert.throws(() => convert(obj({x:z('ZodEnum',{values:[]})})), ZodV3ConversionError)
  assert.throws(() => convert(obj({x:z('ZodEnum',{values:['a','a']})})), ZodV3ConversionError)
})

test('audit: contradictory numeric bounds must be rejected', () => {
  assert.throws(() => convert(obj({x:z('ZodNumber',{checks:[{kind:'min',value:8,inclusive:true},{kind:'max',value:2,inclusive:true}]})})), ZodV3ConversionError)
})
test('audit: exclusive numeric bounds at same value cannot both be satisfied', () => {
  assert.throws(() => convert(obj({x:z('ZodNumber',{checks:[{kind:'min',value:3,inclusive:false},{kind:'max',value:3,inclusive:true}]})})), ZodV3ConversionError)
})
test('audit: malformed array length metadata cannot silently drop constraints', () => {
  for (const length of [0, -1, '3', {bad:3}]) {
    assert.throws(() => convert(obj({x:z('ZodArray',{type:z('ZodString'),minLength:length})})), ZodV3ConversionError)
  }
})
test('audit: malformed numeric inclusivity cannot change the meaning of bounds', () => {
  assert.throws(() => convert(obj({x:z('ZodNumber',{checks:[{kind:'min',value:1}]})})), ZodV3ConversionError)
})
