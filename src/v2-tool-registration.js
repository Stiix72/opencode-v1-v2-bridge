/**
 * V2 Promise-plugin tool registration boundary.
 *
 * The V2 ToolDomain exposes transform(editor => editor.add(info)). The callback
 * is a replayable synchronous registry edit: NEVER run legacy tools in it.
 * The host owns registration lifecycle. No OpenCode installation is touched.
 */
import { isDeepStrictEqual } from 'node:util'
import { LegacyToolRegistryError } from './legacy-tool-registry.js'
import { settleLegacyCleanup } from './legacy-lifecycle.js'

export class V2ToolRegistrationError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'V2ToolRegistrationError'
  }
}

/**
 * Prepare V2 definitions before registering a replayable transform.
 * `makeDefinition` is intentionally explicit until the exact host Tool.Info
 * schema and result representation have been verified against v2.0.27.
 * It may be async; the transform itself must remain synchronous.
 */
export async function prepareV2Tools(snapshot, makeDefinition) {
  if (!snapshot?.tools || typeof snapshot.tools !== 'object') throw new TypeError('invalid legacy tool snapshot')
  if (typeof makeDefinition !== 'function') throw new TypeError('makeDefinition must be a function')
  const result = []
  for (const [name, descriptor] of Object.entries(snapshot.tools)) {
    const definition = await makeDefinition(descriptor, name)
    if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
      throw new V2ToolRegistrationError(`Invalid V2 definition for ${JSON.stringify(name)}`)
    }
    result.push(Object.freeze({ name, definition }))
  }
  return Object.freeze(result)
}

/** Snapshot JSON Schema trees without changing opaque Standard Schema objects.
 * A V2 registry transform may replay long after its caller mutates inputs. */
function snapshotSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  // Opaque Standard Schema implementations retain identity. Never enumerate
  // their internals or invoke their validator to establish acceptance.
  const marker = Object.getOwnPropertyDescriptor(schema, '~standard')
  if (marker) {
    if (!Object.hasOwn(marker, 'value')) throw new V2ToolRegistrationError('Accessor Standard Schema marker')
    const standard = marker.value
    if (standard && typeof standard === 'object') {
      const validate = Object.getOwnPropertyDescriptor(standard, 'validate')
      if (validate && !Object.hasOwn(validate, 'value')) throw new V2ToolRegistrationError('Accessor Standard Schema validator')
      if (validate && typeof validate.value === 'function') return schema
    }
  }
  const seen = new Set()
  const copy = value => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new V2ToolRegistrationError('Non-finite JSON tool schema value')
    if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new V2ToolRegistrationError('Non-JSON tool schema value')
    if (value === null || typeof value !== 'object') return value
    const array = Array.isArray(value)
    const prototype = array ? undefined : Object.getPrototypeOf(value)
    if (!array && prototype !== Object.prototype && prototype !== null) throw new V2ToolRegistrationError('Non-JSON tool schema object')
    if (seen.has(value)) throw new V2ToolRegistrationError('Cyclic JSON tool schema cannot be snapshotted')
    const properties = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new V2ToolRegistrationError('Symbol-keyed JSON tool schema property')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError('Accessor or missing JSON tool schema property')
      properties.push({ key, descriptor })
    }
    let length
    if (array) {
      length = properties.find(property => property.key === 'length')?.descriptor.value
      if (!Number.isInteger(length) || length < 0 || length > 0xFFFFFFFF) throw new V2ToolRegistrationError('Invalid JSON tool schema array length')
      const indices = properties.filter(property => property.key !== 'length')
      if (indices.some(({key,descriptor}) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length || !descriptor.enumerable)) throw new V2ToolRegistrationError('Non-index JSON tool schema array property')
      if (indices.length !== length) throw new V2ToolRegistrationError('Sparse JSON tool schema array')
    } else if (properties.some(({descriptor}) => !descriptor.enumerable)) {
      throw new V2ToolRegistrationError('Non-enumerable JSON tool schema property')
    }
    seen.add(value)
    const result = array ? [] : Object.create(null)
    for (const {key,descriptor} of properties) {
      if (array && key === 'length') continue
      Object.defineProperty(result, key, { value: copy(descriptor.value), enumerable: true, configurable: false, writable: false })
    }
    seen.delete(value)
    return Object.freeze(result)
  }
  return copy(schema)
}

/**
 * Register a replayable tool transform. Collision preflight occurs on every
 * registry replay; if a collision is detected, NO tools from this bridge are
 * added on that replay. The transform is synchronous by V2 contract.
 *
 * `editor.list()` must return objects with `id`; `editor.add` accepts Tool.Info.
 * A namespace or tool id strategy must be supplied by the definition mapper.
 */
/** Required pre-add data is captured once; caller iteration/get access is not authoritative. */
function preaddRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new V2ToolRegistrationError(label.startsWith('Prepared') ? 'Invalid prepared tool definition' : label + ': invalid definitions')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new V2ToolRegistrationError(label + ': inherited definition unsupported')
  return value
}
function preaddData(value, key, label, required = false) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) {
    if (Object.getPrototypeOf(value) !== null && Object.hasOwn(Object.prototype, key)) throw new V2ToolRegistrationError(label + ': inherited identity ' + key)
    if (required) throw new V2ToolRegistrationError(label + ': missing required property ' + key)
    return undefined
  }
  if (!Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError(label + ': accessor property ' + key)
  return descriptor.value
}
function preaddFunction(value, key, label) {
  if (!value || typeof value !== 'object') throw new V2ToolRegistrationError(label + ': native capability unavailable')
  const fn = preaddData(value, key, label, true)
  if (typeof fn !== 'function') throw new V2ToolRegistrationError(label + ': native capability ' + key + ' must be a function')
  return fn
}
function preaddDefinition(value, name) {
  preaddRecord(value, 'Prepared tool')
  const properties = new Map()
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable && !Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError('Accessor or missing prepared tool definition property')
    properties.set(key, descriptor)
  }
  const identity = key => {
    const descriptor = properties.get(key)
    if (!descriptor) {
      if (Object.getPrototypeOf(value) !== null && Object.hasOwn(Object.prototype, key)) throw new V2ToolRegistrationError('Inherited prepared tool identity ' + key)
      return undefined
    }
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new V2ToolRegistrationError('Accessor or non-enumerable prepared tool identity ' + key)
    return descriptor.value
  }
  const id = identity('id'), exposedName = identity('name'), execute = identity('execute')
  if (typeof execute !== 'function') throw new V2ToolRegistrationError('Invalid prepared tool definition')
  if ((id !== undefined && id !== name) || (exposedName !== undefined && exposedName !== name) || (id === undefined && exposedName === undefined)) throw new V2ToolRegistrationError(`Tool identity mismatch for ${JSON.stringify(name)}`)
  const result = {}
  for (const [key, descriptor] of properties) if (descriptor.enumerable) Object.defineProperty(result, key, {value: descriptor.value, enumerable: true, writable: true, configurable: true})
  // Capture the descriptor values before either nested snapshot can reenter caller code.
  const input = properties.get('input'), options = properties.get('options')
  for (const [key, descriptor] of [['input', input], ['options', options]]) {
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError('Accessor prepared tool schema/options')
    if (descriptor?.value !== undefined) Object.defineProperty(result, key, {value: snapshotSchema(descriptor.value), enumerable: true, writable: true, configurable: true})
  }
  return Object.freeze(result)
}

/** Register one replayable native edit; validation completes before its first add. */
export async function registerV2ToolTransform(toolDomain, prepared, {
  getName,
  assertActive = () => {},
} = {}) {
  if (typeof assertActive !== 'function') throw new TypeError('assertActive must be a function')
  if (getName !== undefined && typeof getName !== 'function') throw new TypeError('getName must be a function')
  assertActive()
  const transform = preaddFunction(toolDomain, 'transform', 'V2 tool.transform')
  const assertDomain = () => {
    assertActive()
    if (preaddFunction(toolDomain, 'transform', 'V2 tool.transform') !== transform) throw new V2ToolRegistrationError('Native tool.transform capability ownership changed')
    assertActive()
  }
  const rows = []
  for (const entry of acceptanceArray(prepared, 'prepared tool inventory')) {
    preaddRecord(entry, 'Prepared tool entry')
    rows.push({entry, name: preaddData(entry, 'name', 'Prepared tool entry'), definition: preaddData(entry, 'definition', 'Prepared tool entry', true)})
  }
  const names = []
  for (const row of rows) {
    assertDomain()
    const name = getName === undefined ? row.name : getName(row.entry)
    assertDomain()
    names.push(name)
  }
  if (new Set(names).size !== names.length) throw new V2ToolRegistrationError('duplicate prepared tool names')
  for (const name of names) if (typeof name !== 'string' || !name) throw new TypeError('invalid tool name')
  const entries = []
  for (let index = 0; index < rows.length; index++) {
    assertDomain()
    entries.push(Object.freeze({name: names[index], definition: preaddDefinition(rows[index].definition, names[index])}))
  }
  assertDomain()
  const registration = await Reflect.apply(transform, toolDomain, [editor => {
    assertDomain()
    const list = preaddFunction(editor, 'list', 'V2 tool editor missing list/add'), add = preaddFunction(editor, 'add', 'V2 tool editor missing list/add')
    const assertEditor = () => {
      assertDomain()
      if (preaddFunction(editor, 'list', 'V2 tool editor') !== list || preaddFunction(editor, 'add', 'V2 tool editor') !== add) throw new V2ToolRegistrationError('Native tool editor capability ownership changed')
      assertDomain()
    }
    assertEditor()
    const inventory = acceptanceArray(Reflect.apply(list, editor, []), 'V2 tool editor.list returned invalid definitions'), existing = new Set()
    for (const item of inventory) {
      preaddRecord(item, 'Pre-add tool inventory')
      const id = preaddData(item, 'id', 'Pre-add tool inventory'), name = preaddData(item, 'name', 'Pre-add tool inventory')
      if ((typeof id !== 'string' && typeof name !== 'string') || (id !== undefined && (typeof id !== 'string' || !id)) || (name !== undefined && (typeof name !== 'string' || !name))) throw new V2ToolRegistrationError('V2 tool editor.list returned invalid definitions')
      if (typeof id === 'string') existing.add(id)
      if (typeof name === 'string') existing.add(name)
    }
    for (const name of names) if (existing.has(name)) throw new LegacyToolRegistryError(`V2 tool ${JSON.stringify(name)} already registered`, {tool: name})
    assertEditor()
    for (const entry of entries) {
      assertEditor()
      Reflect.apply(add, editor, [entry.definition])
    }
    assertEditor()
    assertV2ToolAcceptance(Reflect.apply(list, editor, []), entries, 'tool editor replay', assertEditor)
    assertEditor()
  }])
  try {
    assertDomain()
    return registration
  } catch (error) {
    // The native registration completed after its activation/capability changed.
    // Release this newly returned handle; never publish stale success or retry.
    try {
      const dispose = preaddFunction(registration, 'dispose', 'Stale tool registration')
      await settleLegacyCleanup([() => Reflect.apply(dispose, registration, [])], {label: 'Stale tool registration cleanup failed', labels: ['native tool transform disposal']})
    } catch (cleanupError) {
      const failure = new V2ToolRegistrationError('Tool registration ownership and cleanup failed', new AggregateError([error, cleanupError]))
      failure.cleanupFailed = true
      if (cleanupError.cleanupDone) failure.cleanupDone = cleanupError.cleanupDone
      throw failure
    }
    throw error
  }
}

/** Capture own response data, not getters, inherited substitutes or iteration. */
function acceptanceData(record, key, phase) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError(phase + ': accessor accepted tool property ' + key)
  return descriptor.value
}
function acceptanceRecord(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new V2ToolRegistrationError(phase + ': invalid accepted tool definition')
  const prototype = Object.getPrototypeOf(value)
  // Both the exact native registry and Promise facade publish spread records.
  if (prototype !== Object.prototype && prototype !== null) throw new V2ToolRegistrationError(phase + ': inherited accepted tool definition')
  return value
}
function acceptanceArray(value, phase) {
  if (!Array.isArray(value)) throw new V2ToolRegistrationError(phase + ': invalid accepted tool inventory')
  const length = acceptanceData(value, 'length', phase)
  if (!Number.isInteger(length) || length < 0 || length > 0xFFFFFFFF) throw new V2ToolRegistrationError(phase + ': invalid accepted tool inventory length')
  const slots = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new V2ToolRegistrationError(phase + ': sparse or accessor accepted tool inventory')
    slots.push(descriptor.value)
  }
  // Retain rejection of enumerable inventory decorations, without calling
  // supplied array methods or reading the original length again.
  const keys = Object.keys(value)
  if (keys.length !== length) throw new V2ToolRegistrationError(phase + ': invalid accepted tool inventory')
  return slots
}
function acceptanceMetadata(value) {
  const snapshot = snapshotSchema(value)
  return { snapshot, opaque: value !== null && typeof value === 'object' && snapshot === value }
}

/** Verify supplied definitions only; never select or execute a tool.
 * The optional guard belongs to the existing activation, not a new lifetime. */
export function assertV2ToolAcceptance(listed, prepared, phase = 'host registry', assertActive = () => {}) {
  if (typeof assertActive !== 'function') throw new TypeError('assertActive must be a function')
  assertActive()
  const expected = []
  for (const entry of acceptanceArray(prepared, phase)) {
    acceptanceRecord(entry, phase)
    const name = acceptanceData(entry, 'name', phase)
    const definition = acceptanceRecord(acceptanceData(entry, 'definition', phase), phase)
    if (typeof name !== 'string' || !name) throw new V2ToolRegistrationError(phase + ': invalid prepared tool identity')
    const metadata = Object.create(null)
    for (const key of ['input', 'description', 'options']) {
      const value = acceptanceData(definition, key, phase)
      if (value !== undefined) metadata[key] = acceptanceMetadata(value)
    }
    expected.push({ name, metadata })
  }
  const accepted = []
  for (const item of acceptanceArray(listed, phase)) {
    acceptanceRecord(item, phase)
    const record = Object.create(null)
    for (const key of ['id', 'name', 'execute', 'input', 'description', 'options']) record[key] = acceptanceData(item, key, phase)
    for (const key of ['id', 'name']) {
      if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key])) throw new V2ToolRegistrationError(phase + ': invalid accepted tool identity')
    }
    // Inspect nested data only for records relevant to these registrations.
    // Unrelated native metadata remains outside this check's authority.
    const relevant = expected.some(entry => record.id === entry.name || record.name === entry.name)
    if (relevant) {
      record.metadata = Object.create(null)
      for (const key of ['input', 'description', 'options']) record.metadata[key] = acceptanceMetadata(record[key])
    }
    accepted.push(record)
  }
  assertActive()
  for (const {name,metadata} of expected) {
    const matches = accepted.filter(record => record.id === name || record.name === name)
    const record = matches[0]
    if (matches.length !== 1 || typeof record.execute !== 'function' ||
        (record.id !== undefined && record.id !== name) || (record.name !== undefined && record.name !== name)) {
      throw new V2ToolRegistrationError(phase + ': host skipped, rejected or changed legacy tool ' + JSON.stringify(name))
    }
    for (const key of ['input', 'description', 'options']) {
      if (!Object.hasOwn(metadata, key)) continue
      const actual = record.metadata[key], wanted = metadata[key]
      // Host adapters preserve schema references. Equivalence of distinct
      // executable validators cannot be established by inspecting internals.
      const equal = actual.opaque || wanted.opaque
        ? actual.opaque === wanted.opaque && actual.snapshot === wanted.snapshot
        : isDeepStrictEqual(actual.snapshot, wanted.snapshot)
      if (!equal) throw new V2ToolRegistrationError(phase + ': host changed ' + key + ' for legacy tool ' + JSON.stringify(name))
    }
  }
  assertActive()
}
