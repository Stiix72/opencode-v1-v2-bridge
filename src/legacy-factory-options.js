/** Explicit per-target configuration. No inference, resolution or installation here. */
export class LegacyFactoryOptionsError extends TypeError {
  constructor(message){super(message);this.name='LegacyFactoryOptionsError'}
}
function fail(where,message){throw new LegacyFactoryOptionsError(where+': '+message)}
function plain(value,where){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(where,'expected a plain options record')
}
function entries(value,where){
  return Reflect.ownKeys(value).map(key=>{
    if(typeof key!=='string')fail(where,'symbol keys are unsupported')
    const descriptor=Object.getOwnPropertyDescriptor(value,key)
    if(!descriptor||!Object.hasOwn(descriptor,'value'))fail(where+'.'+key,'accessors are unsupported')
    if(!descriptor.enumerable)fail(where+'.'+key,'non-enumerable properties are unsupported')
    return [key,descriptor.value]
  })
}
/** JSON-compatible configuration only, with no serialization coercion or dropped fields.
 * Copies are mutable for the plugin. Caller identity/aliases are not a contract. */
export function cloneFactoryOptions(value){
  plain(value,'factory options')
  const stack=new Set()
  function clone(input,where){
    if(input===null||typeof input==='string'||typeof input==='boolean')return input
    if(typeof input==='number'){if(!Number.isFinite(input))fail(where,'non-finite numbers are unsupported');return input}
    if(!input||typeof input!=='object')fail(where,'unsupported configuration value')
    if(stack.has(input))fail(where,'cyclic configuration is unsupported')
    stack.add(input)
    try{
      if(Array.isArray(input)){
        if(Object.getPrototypeOf(input)!==Array.prototype)fail(where,'custom array prototypes are unsupported')
        const keys=Reflect.ownKeys(input).filter(key=>key!=='length')
        if(keys.length!==input.length)fail(where,'sparse or extended arrays are unsupported')
        const result=[]
        for(let index=0;index<input.length;index++){
          const descriptor=Object.getOwnPropertyDescriptor(input,String(index))
          if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail(where,'array accessors or holes are unsupported')
          result.push(clone(descriptor.value,where+'['+index+']'))
        }
        return result
      }
      plain(input,where)
      const result=Object.create(Object.getPrototypeOf(input))
      for(const [key,item]of entries(input,where))Object.defineProperty(result,key,{value:clone(item,where+'.'+key),enumerable:true,writable:true,configurable:true})
      return result
    }finally{stack.delete(input)}
  }
  return clone(value,'factory options')
}
export const legacyTargetName=entry=>typeof entry==='string'?entry:entry[0]
/** V1 Config.plugin string/[target, PluginOptions] shape; snapshot before any await. */
export function snapshotLegacyTargets(targets){
  if(!Array.isArray(targets))throw new TypeError('targets must be an array')
  const selected=[]
  for(let index=0;index<targets.length;index++){
    const item=Object.getOwnPropertyDescriptor(targets,String(index))
    if(!item||!Object.hasOwn(item,'value'))fail('targets','sparse lists or accessors are unsupported')
    const entry=item.value
    if(typeof entry==='string'&&entry.trim()){selected.push(entry);continue}
    if(!Array.isArray(entry)||entry.length!==2||Reflect.ownKeys(entry).length!==3)fail('targets['+index+']','expected a target string or [target, options]')
    const name=Object.getOwnPropertyDescriptor(entry,'0'),options=Object.getOwnPropertyDescriptor(entry,'1')
    if(!name||!options||!Object.hasOwn(name,'value')||!Object.hasOwn(options,'value'))fail('targets['+index+']','tuple accessors or holes are unsupported')
    if(typeof name.value!=='string'||!name.value.trim())fail('targets['+index+']','target must be nonempty')
    selected.push([name.value,cloneFactoryOptions(options.value)])
  }
  return selected
}
/** Bridge-owned namespace in the actual native ctx.options record. Unknown
 * targets fail, absent entries retain static specs, overrides REPLACE not merge.
 * Unrelated native options are never forwarded to legacy factories. */
export function applyNativeFactoryOptions(targets,nativeOptions){
  const selected=snapshotLegacyTargets(targets)
  if(nativeOptions===undefined)return selected
  plain(nativeOptions,'native ctx.options')
  const descriptor=Object.getOwnPropertyDescriptor(nativeOptions,'legacyFactoryOptions')
  if(!descriptor)return selected
  if(!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail('legacyFactoryOptions','expected an enumerable data property')
  const overrides=descriptor.value
  plain(overrides,'legacyFactoryOptions')
  const names=new Set(selected.map(legacyTargetName)),mapped=new Map()
  // Validate the entire override map before initializing any target.
  for(const [target,options]of entries(overrides,'legacyFactoryOptions')){
    if(!names.has(target))fail('legacyFactoryOptions','override target is not explicitly declared: '+target)
    mapped.set(target,cloneFactoryOptions(options))
  }
  return selected.map(entry=>mapped.has(legacyTargetName(entry))?[legacyTargetName(entry),mapped.get(legacyTargetName(entry))]:entry)
}
