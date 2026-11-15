/** Explicit reduced post-request observation. No permission decision API is used. */
import {UnsupportedLegacyAPIError} from './legacy-context.js'
import {cloneFactoryOptions} from './legacy-factory-options.js'
import {isDeepStrictEqual} from 'node:util'
export class PendingPermissionObserverError extends Error {
  constructor(message,cause){super(message,{cause});this.name='PendingPermissionObserverError'}
}
const fail=message=>{throw new PendingPermissionObserverError(message)}
const record=(value,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(label+' must be a plain record')
  return value
}
const field=(value,key,required=false)=>{
  const d=Object.getOwnPropertyDescriptor(value,key)
  if(!d){if(required)fail('Missing pending-permission field: '+key);return undefined}
  if(!Object.hasOwn(d,'value')||!d.enumerable)fail('Pending-permission field must be data: '+key)
  return d.value
}
const text=(value,label,prefix)=>{
  if(typeof value!=='string'||prefix&&!value.startsWith(prefix))fail('Invalid '+label)
  return value
}
const strings=(value,label)=>{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)fail('Invalid '+label)
  return Array.from({length:value.length},(_,i)=>text(field(value,String(i),true),label+'['+i+']'))
}
/** Native Request projection only. No legacy names/title/time are invented. */
export function snapshotPendingPermissionRequest(value){
  record(value,'Native pending permission')
  const out={id:text(field(value,'id',true),'permission id','per'),sessionID:text(field(value,'sessionID',true),'permission session','ses'),
    action:text(field(value,'action',true),'permission action'),resources:strings(field(value,'resources',true),'permission resources')}
  for(const key of ['save','message','metadata','source']){
    const item=field(value,key)
    if(item===undefined)continue
    if(key==='save')out.save=strings(item,'permission save')
    else if(key==='message')out.message=text(item,'permission message')
    else if(key==='metadata'){
      record(item,'Permission metadata')
      try{out.metadata=cloneFactoryOptions(item)}catch(cause){throw new PendingPermissionObserverError('Observer metadata requires plain JSON data',cause)}
    }else{
      record(item,'Permission source')
      if(field(item,'type',true)!=='tool')fail('Unsupported native permission source')
      out.source={type:'tool',messageID:text(field(item,'messageID',true),'source message'),id:text(field(item,'id',true),'source call')}
    }
  }
  return out
}
const unsupported=fieldName=>{throw new UnsupportedLegacyAPIError('permission.ask pending observer '+fieldName)}
function observation(request){
  let active=true
  const assert=()=>{if(!active)fail('Pending-permission observation is no longer active')}
  const readOnly=value=>{
    if(!value||typeof value!=='object')return value
    const out=Array.isArray(value)?[]:Object.create(null)
    for(const [key,item]of Object.entries(value))Object.defineProperty(out,key,{value:readOnly(item),enumerable:true,writable:false,configurable:false})
    Object.freeze(out)
    return new Proxy(out,{get(target,key,receiver){assert();return Reflect.get(target,key,receiver)},ownKeys(target){assert();return Reflect.ownKeys(target)},
      getOwnPropertyDescriptor(target,key){assert();return Reflect.getOwnPropertyDescriptor(target,key)},
      set(){return unsupported('input mutation')},defineProperty(){return unsupported('input mutation')},deleteProperty(){return unsupported('input mutation')},
      setPrototypeOf(){return unsupported('input mutation')},preventExtensions(){return unsupported('input mutation')}})
  }
  const available={id:request.id,sessionID:request.sessionID,
    ...(request.source?{messageID:request.source.messageID,callID:request.source.id}:{}),
    ...(Object.hasOwn(request,'metadata')?{metadata:readOnly(request.metadata)}:{})}
  const input=Object.create(null)
  for(const key of ['id','type','pattern','sessionID','messageID','callID','title','metadata','time'])Object.defineProperty(input,key,{enumerable:true,configurable:false,
    get(){assert();if(!Object.hasOwn(available,key))return unsupported('input.'+key+' is unavailable');return available[key]}})
  const wrap=(object,label)=>new Proxy(Object.preventExtensions(object),{
    get(target,key,receiver){assert();if(typeof key==='symbol')return Reflect.get(target,key,receiver);if(!Object.hasOwn(target,key))return unsupported(label+'.'+key);return Reflect.get(target,key,receiver)},
    ownKeys(target){assert();return Reflect.ownKeys(target)},getOwnPropertyDescriptor(target,key){assert();return Reflect.getOwnPropertyDescriptor(target,key)},
    set(){return unsupported(label+' mutation')},defineProperty(){return unsupported(label+' mutation')},deleteProperty(){return unsupported(label+' mutation')},
    setPrototypeOf(){return unsupported(label+' mutation')},preventExtensions(){return unsupported(label+' mutation')}})
  const output=Object.create(null)
  Object.defineProperty(output,'status',{enumerable:true,configurable:false,get(){assert();return unsupported('output.status has no decision access')},set(){return unsupported('output.status mutation')}})
  return {input:wrap(input,'input'),output:wrap(output,'output'),revoke(){active=false}}
}
/** One mapper belongs to one selected target/activation/subscription.
 * Current pending membership is checked read-only before callback admission.
 * Repeated identical transport frames skip; conflicting/reused identities fail.
 */
export function createPendingPermissionObserverMapper({isOpen,checkPending,maxRequests=4096}={}){
  if(typeof isOpen!=='function'||typeof checkPending!=='function')throw new TypeError('Observer requires explicit admission and pending-read bindings')
  if(!Number.isSafeInteger(maxRequests)||maxRequests<1)throw new TypeError('Observer maxRequests must be positive')
  const events=new Map(),requests=new Map(),observations=new Set()
  let closed=false,duplicates=0,settled=0,mapped=0
  return Object.freeze({
    async mapEvent(event){
      if(closed)fail('Pending-permission mapper disposed')
      if(!isOpen())return null
      record(event,'Native event')
      const type=text(field(event,'type',true),'native event type')
      if(type!=='permission.asked')return null
      const eventID=text(field(event,'id',true),'native event id','evt_'),created=field(event,'created',true)
      if(typeof created!=='number'||!Number.isFinite(created)||created<0)fail('Invalid native event timestamp')
      if(field(event,'durable')!==undefined)fail('Pending-permission Asked must be ephemeral')
      const request=snapshotPendingPermissionRequest(field(event,'data',true))
      const fingerprint={created,request}
      if(events.has(eventID)){
        if(!isDeepStrictEqual(events.get(eventID),fingerprint))fail('Conflicting duplicate permission event')
        duplicates++;return null
      }
      if(requests.has(request.id))fail('Repeated native permission request identity')
      if(events.size>=maxRequests)fail('Pending-permission observer capacity exhausted')
      events.set(eventID,fingerprint);requests.set(request.id,eventID)
      const pending=await checkPending(request,isOpen)
      if(typeof pending!=='boolean')fail('Pending-read binding must return a boolean')
      if(closed||!isOpen())return null
      if(!pending){settled++;return null}
      const value=observation(request),revoke=value.revoke
      value.revoke=()=>{revoke();observations.delete(value)}
      observations.add(value);mapped++
      return {type:'permission.asked',properties:value}
    },
    dispose(){if(closed)return;closed=true;for(const item of observations)item.revoke();observations.clear();events.clear();requests.clear()},
    snapshot(){return Object.freeze({closed,mapped,duplicates,settled,requests:requests.size,observations:observations.size})}
  })
}

/** Canonical resolved files only; permissions remain per target, never global. */
export function snapshotPendingObserverTargets(value=[]){
  if(!Array.isArray(value)||Reflect.ownKeys(value).length!==value.length+1)throw new TypeError('pendingPermissionObserverTargets must be a dense URL list')
  const found=new Set(),out=[]
  for(let i=0;i<value.length;i++){
    const d=Object.getOwnPropertyDescriptor(value,String(i))
    if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string')throw new TypeError('Observer target must be a file URL data property')
    let url;try{url=new URL(d.value)}catch{throw new TypeError('Observer target must be a canonical file URL')}
    if(url.protocol!=='file:'||url.search||url.hash||url.href!==d.value||found.has(d.value))throw new TypeError('Observer target must be a unique canonical file URL')
    found.add(d.value);out.push(d.value)
  }
  return Object.freeze(out)
}
