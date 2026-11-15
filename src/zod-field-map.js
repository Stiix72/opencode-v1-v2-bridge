/** Raw-shape ownership and original-field parsing; no Zod runtime substitution. */
export function fieldEntries(fields,allowUnsafeNames=false){
 if(!fields||typeof fields!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(fields)))throw new TypeError('Expected a plain Zod field map')
 return Reflect.ownKeys(fields).map(name=>{
  if(typeof name!=='string')throw new TypeError('Symbol field names are unsupported')
  const d=Object.getOwnPropertyDescriptor(fields,name)
  if(!d||!Object.hasOwn(d,'value')||!d.enumerable)throw new TypeError('Accessor/non-enumerable Zod fields are unsupported')
  if(!allowUnsafeNames&&['__proto__','constructor','prototype'].includes(name))throw new TypeError('Unsafe field name: '+name)
  return[name,d.value]
 })
}
export function fieldVersion(field){
 if(!field||typeof field!=='object'||typeof field.parse!=='function')return undefined
 if(typeof field._def?.typeName==='string'&&field._def.typeName.startsWith('Zod'))return 3
 if(field['~standard']?.vendor==='zod'&&typeof field.def?.type==='string')return 4
}
export function isFieldMap(fields,version){try{return fieldEntries(fields).every(([,field])=>fieldVersion(field)===version)}catch{return false}}
export function snapshotFieldMap(fields){
 const entries=fieldEntries(fields),versions=new Set(entries.map(([,field])=>fieldVersion(field)))
 if(versions.has(undefined)||versions.size>1)throw new TypeError('Expected a homogeneous Zod v3 or v4 field map')
 return Object.freeze(Object.fromEntries(entries))
}
/** Original parsers are captured before registration; mutable source maps are
 * never rediscovered by tool name or re-read during execution. V3 errors keep
 * original issue paths; multiple errors are an honest AggregateError. */
export function createFieldMapParser(fields){
 const snapshot=snapshotFieldMap(fields),entries=Object.entries(snapshot).map(([name,field])=>({name,version:fieldVersion(field),parse:field.parse.bind(field)}))
 return input=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||input instanceof Date||input instanceof Map||input instanceof Set)throw new TypeError('Tool input must be object')
  const parsed={},failures=[]
  for(const {name,version,parse}of entries){
   try{
    const value=version===3?parse(input[name],{path:[name]}):parse(input[name])
    if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});throw new TypeError('Asynchronous field parsing is unsupported')}
    // Matches Zod object presence semantics: explicit undefined is preserved.
    if(value!==undefined||name in input)Object.defineProperty(parsed,name,{value,enumerable:true,writable:true,configurable:true})
   }catch(error){failures.push(error)}
  }
  if(failures.length)throw failures.length===1?failures[0]:new AggregateError(failures,'Zod field-map validation failed')
  return parsed
 }
}
