/** Public, versioned configuration only. No environment discovery or installation. */
import path from 'node:path'
import {cloneFactoryOptions} from './legacy-factory-options.js'
export class ServerConfigurationError extends TypeError {
  constructor(message,cause){super(message,{cause});this.name='ServerConfigurationError'}
}
const fail=message=>{throw new ServerConfigurationError(message)}
const record=(value,keys,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(label+' must be an object')
  for(const key of Object.keys(value))if(!keys.includes(key))fail(label+': unsupported option '+key)
}
const text=(value,label)=>{if(typeof value!=='string'||!value.trim()||value!==value.trim())fail(label+' must be a nonempty unpadded string');return value}
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value)}return value}
/** Snapshot all JSON before importing any target; caller objects are never retained. */
export function validateServerOptions(input){
  let value
  try{value=cloneFactoryOptions(input)}catch(cause){throw new ServerConfigurationError('Bridge options must be a plain JSON configuration',cause)}
  record(value,['version','targets','toolExposure','clientOptions','logging','events','system','metadata'],'bridge')
  if(value.version!==1)fail('bridge.version must be 1')
  if(!Array.isArray(value.targets)||!value.targets.length)fail('bridge.targets must be a nonempty list')
  const ids=new Set(),modules=new Set(),commands=new Set()
  const targets=value.targets.map((entry,index)=>{
    const label='targets['+index+']';record(entry,['id','module','options','commands','pendingPermissionObserver','sessionCreated'],label)
    const id=text(entry.id,label+'.id'),module=text(entry.module,label+'.module')
    if(!/^[A-Za-z][\w.-]*$/.test(id))fail(label+'.id must start with a letter and contain only letters, digits, _, . or -')
    if(ids.has(id))fail('Duplicate target id: '+id);ids.add(id)
    if(modules.has(module))fail('Duplicate target module: '+module);modules.add(module)
    // Explicit file entrypoints or bare package specifiers. Never URLs, npm versions,
    // drive-relative paths or Windows paths interpreted as package names elsewhere.
    const windows=path.win32.isAbsolute(module)
    const file=module.startsWith('file:')
    if(file){let url;try{url=new URL(module)}catch{fail(label+'.module is not a file URL')}
      if(url.protocol!=='file:'||url.search||url.hash)fail(label+'.module must be an unqualified file URL')
    }else if(module.includes('://')||/^[A-Za-z]:/.test(module)&&!windows||windows&&process.platform!=='win32'||
      !windows&&!path.isAbsolute(module)&&!module.startsWith('./')&&!module.startsWith('../')&&
      (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(module)||module.split('/').some(p=>p==='.'||p==='..'))){
      fail(label+'.module must be a local file entrypoint or an installed bare package/subpath')
    }
    const out={id,module}
    if(Object.hasOwn(entry,'sessionCreated')){
      if(typeof entry.sessionCreated!=='boolean')fail(label+'.sessionCreated must be boolean')
      if(entry.sessionCreated&&value.events!=='session-lifecycle')fail(label+'.sessionCreated requires events: session-lifecycle')
      out.sessionCreated=entry.sessionCreated
    }
    if(Object.hasOwn(entry,'pendingPermissionObserver')){if(typeof entry.pendingPermissionObserver!=='boolean')fail(label+'.pendingPermissionObserver must be boolean');out.pendingPermissionObserver=entry.pendingPermissionObserver}
    if(Object.hasOwn(entry,'options')){record(entry.options,Object.keys(entry.options??{}),label+'.options');out.options=entry.options}
    if(Object.hasOwn(entry,'commands')){
      if(!Array.isArray(entry.commands)||!entry.commands.length)fail(label+'.commands must be a nonempty list')
      out.commands=entry.commands.map(name=>{
        if(typeof name!=='string'||! /^[A-Za-z][\w.-]*$/.test(name))fail(label+'.commands contains an invalid name')
        if(commands.has(name))fail('Conflicting command name: '+name);commands.add(name);return name
      })
    }
    return out
  })
  const out={version:1,targets,toolExposure:value.toolExposure??'direct'}
  if(!['direct','code-mode'].includes(out.toolExposure))fail('toolExposure must be direct or code-mode')
  if(Object.hasOwn(value,'events')){if(!['terminal-assistant','session-lifecycle'].includes(value.events))fail('events supports only the explicit terminal-assistant or session-lifecycle profile');out.events=value.events}
  for(const [key,allowed]of Object.entries({logging:'stderr',system:'session-text',metadata:'live-json'})){
    if(Object.hasOwn(value,key)){if(value[key]!==allowed)fail(key+' supports only the explicit '+allowed+' profile');out[key]=value[key]}
  }
  if(Object.hasOwn(value,'clientOptions')){
    record(value.clientOptions,['responseStyle','throwOnError'],'clientOptions')
    if(value.clientOptions.responseStyle!=='data'||value.clientOptions.throwOnError!==true)fail('clientOptions requires responseStyle=data and throwOnError=true')
    out.clientOptions=value.clientOptions
  }
  return freeze(out)
}
