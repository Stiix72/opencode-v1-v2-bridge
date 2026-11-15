import {copy, record} from './tool-result-data.js'

// Private weak provenance: exact v2.0.27 Tool runtime preserves metadata identity
// into execute.after. No tool/session registry, strong activation cache or host API.
const observations = new WeakMap()

// Only call on already detached plain-data snapshots (never arbitrary accessors).
export function sameMetadataData(a,b) {
  if(Object.is(a,b))return true
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false
  const keys=Object.keys(a)
  return keys.length===Object.keys(b).length && keys.every(k=>Object.hasOwn(b,k)&&sameMetadataData(a[k],b[k]))
}

export function legacyMetadataView(value) {
  const current=copy(value), saved=observations.get(value)
  // An unrelated native callback may have modified the projected object. Never
  // overwrite it with stale hidden metadata or pretend we can merge its intent.
  return saved && sameMetadataData(current,saved.durable) ? copy(saved.legacy) : current
}
export const isLegacyMetadata = value => observations.has(value)

function project(value,path) {
  if(value===undefined)throw new TypeError('Undefined metadata array element at '+path)
  if(value===null||typeof value!=='object')return value // copy already validates scalars
  const array=Array.isArray(value), out=array?[]:{}
  if(array && Object.keys(value).length!==value.length)throw new TypeError('Metadata array properties are unsupported at '+path)
  for(const key of Object.keys(value)) {
    if(!array && value[key]===undefined)continue
    Object.defineProperty(out,key,{value:project(value[key],path+'/'+key),enumerable:true,writable:true,configurable:true})
  }
  return out
}

/** JSON-facing view, not a claim that JavaScript own undefined equals absence.
 * Legacy callbacks retain a separate detached view; arrays never coerce to null.
 * Existing copy rejects getters/classes/symbols/cycles/nonfinite numbers/etc.
 */
export function durableLegacyMetadata(value) {
  const legacy=legacyMetadataView(value)
  if(!record(legacy))throw new TypeError('Durable legacy metadata must be a plain record')
  const durable=project(legacy,'metadata')
  observations.set(durable,{legacy,durable:copy(durable)})
  return durable
}
