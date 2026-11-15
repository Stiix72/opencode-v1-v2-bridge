export const LEGACY_TITLE_METADATA_KEY = 'opencodeV1Bridge'
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

// Detached plain data only: no getters, toJSON, shared mutable objects or classes.
// Undefined is retained in-process; no JSON serialization/loss is used here.
export function copy(value, ancestors = new Set()) {
  if (value === undefined || value === null || ['string','boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value
  if ((!Array.isArray(value) && !record(value)) || ancestors.has(value)) throw new TypeError('Hook data must be an acyclic plain-data tree')
  ancestors.add(value)
  const out = Array.isArray(value) ? [] : {}
  if (Array.isArray(value)) for (let i=0;i<value.length;i++) if (!Object.hasOwn(value,i)) throw new TypeError('Sparse hook arrays are unsupported')
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const d = Object.getOwnPropertyDescriptor(value,key)
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d,'value') || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new TypeError('Hook accessors/symbols/array properties are unsupported')
    Object.defineProperty(out,key,{value:copy(d.value,ancestors),writable:true,configurable:true,enumerable:true})
  }
  ancestors.delete(value)
  return out
}
