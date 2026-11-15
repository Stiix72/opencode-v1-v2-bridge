/** Strict JSON/data profile shared by the opt-in client adapters; no host discovery. */
import path from 'node:path'
import {createLegacyLifetime,settleLegacyCleanup} from './legacy-lifecycle.js'
import {UnsupportedLegacyAPIError} from './legacy-context.js'
export class LegacyClientCapabilityError extends Error {
  constructor(code,message,cause){super(message,{cause});this.name='LegacyClientCapabilityError';this.code=code}
}
export const failure=(code,message,cause)=>new LegacyClientCapabilityError(code,message,cause)
export function record(value,label,allowed){
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' must be a plain record')
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' has an unsupported descriptor');if(allowed&&!allowed.includes(key))throw new UnsupportedLegacyAPIError(label+'.'+key)}
  return value
}
export function jsonCopy(value,seen=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(typeof value!=='object'||seen.has(value))throw new TypeError('Capability payload must be finite acyclic JSON; no lossy conversion')
  seen.add(value);let out
  if(Array.isArray(value)){out=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Sparse/accessor arrays unsupported');out.push(jsonCopy(d.value,seen))}if(Reflect.ownKeys(value).some(k=>k!=='length'&&!(typeof k==='string'&&/^(0|[1-9]\d*)$/.test(k)&&Number(k)<value.length)))throw new TypeError('Decorated array unsupported')}
  else{record(value,'JSON');out={};for(const key of Object.keys(value))Object.defineProperty(out,key,{value:jsonCopy(value[key],seen),enumerable:true,writable:true,configurable:true})}
  seen.delete(value);return out
}
export function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value)}return value}
export function ownerOf(ctx){const l=ctx?.location,p=l?.project;if(!l||!p)throw new TypeError('Native location/project required');const out={directory:l.directory,projectID:p.id,worktree:p.directory,canonical:p.canonical};for(const k of ['directory','worktree','canonical'])if(typeof out[k]!=='string'||!path.isAbsolute(out[k]))throw new TypeError('Absolute owner '+k+' required');if(typeof out.projectID!=='string'||!out.projectID)throw new TypeError('Owner project ID required');if(l.workspaceID!==undefined){if(typeof l.workspaceID!=='string'||!l.workspaceID)throw new TypeError('Invalid workspace ID');out.workspaceID=l.workspaceID}return freeze(out)}
export function sameOwner(a,b){return a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k])}
export function assertOwner(ctx,owner){if(!sameOwner(ownerOf(ctx),owner))throw failure('ownership','Client activation/location ownership changed')}
export function timeout(value=2000){if(!Number.isSafeInteger(value)||value<1||value>60000)throw new TypeError('Client deadline must be an integer from 1 through 60000 ms');return value}
export function requestBody(request,method,defaults,owner){
  const r=record(request??{},'client.'+method,['body','query','responseStyle','throwOnError','signal']);
  if(r.responseStyle!==undefined&&!['data','fields'].includes(r.responseStyle)||r.throwOnError!==undefined&&typeof r.throwOnError!=='boolean')throw new TypeError('Invalid client result options')
  if((r.responseStyle??defaults.responseStyle??'fields')!=='data'||(r.throwOnError??defaults.throwOnError??false)!==true)throw new UnsupportedLegacyAPIError('client.'+method+' requires explicit responseStyle=data and throwOnError=true; HTTP envelopes are unavailable')
  if(r.signal!==undefined)throw new UnsupportedLegacyAPIError('client.'+method+' request cancellation; no false native cancellation forwarding')
  if(r.query!==undefined){record(r.query,'client query',['directory']);if(r.query.directory!==undefined&&r.query.directory!==owner.directory)throw failure('ownership','Cross-location client request rejected')}
  const b=record(r.body,'client.'+method+' body',method==='app.log'?['service','level','message','extra']:['title','message','variant','duration']);const out={}
  const string=k=>{if(typeof b[k]!=='string')throw new TypeError(method+' requires string '+k);out[k]=b[k]}
  if(method==='app.log'){string('service');string('level');if(!['debug','info','warn','error'].includes(b.level))throw new TypeError('Invalid V1 log level');string('message');if(b.extra!==undefined){record(b.extra,'log extra');out.extra=jsonCopy(b.extra)}}
  else{string('message');string('variant');if(!['info','success','warning','error'].includes(b.variant))throw new TypeError('Invalid V1 toast variant');if(b.title!==undefined)string('title');if(b.duration!==undefined){if(typeof b.duration!=='number'||!Number.isFinite(b.duration))throw new TypeError('Toast duration must be finite');out.duration=b.duration}}
  return freeze(out)
}
/** Retains underlying tasks after a deadline; revocation is not a claim of cancellation. */
export function clientOperations(assertValid,label){
  const life=createLegacyLifetime(label),jobs=new Set(),pending=new Set(),lateFailures=[];let closing
  const start=(task,validate,deadline)=>life.run(()=>{
    assertValid();const controller=new AbortController();let settled=false,resolve,reject,timer
    const result=new Promise((yes,no)=>{resolve=yes;reject=no});const finish=(error,value)=>{if(settled)return false;settled=true;clearTimeout(timer);pending.delete(entry);error?reject(error):resolve(value);return true}
    const entry={cancel(error){finish(error);controller.abort(error)}};pending.add(entry);if(deadline!==undefined)timer=setTimeout(()=>entry.cancel(failure('timeout',label+' acknowledgement deadline exceeded; outcome unconfirmed')),deadline)
    const job=Promise.resolve().then(()=>{life.assertActive();assertValid();if(controller.signal.aborted)throw controller.signal.reason;return task(controller.signal)}).then(value=>{if(controller.signal.aborted)return;const result=validate(value);assertValid();if(!finish(null,result)&&!controller.signal.aborted)throw failure('late-result','Unexpected late client result')},error=>{if(!finish(error)&&error!==controller.signal.reason)lateFailures.push(error)})
    jobs.add(job);job.then(()=>jobs.delete(job),error=>{jobs.delete(job);if(!finish(error)&&error!==controller.signal.reason)lateFailures.push(error)})
    return result
  })
  const revoke=()=>{if(life.stopped)return;life.stop();const error=failure('disposed',label+' disposed; pending outcomes unconfirmed');for(const entry of [...pending])entry.cancel(error)}
  return Object.freeze({start,revoke,assertActive(){life.assertActive();assertValid()},get pending(){return pending.size},get inFlight(){return jobs.size},dispose(tasks=[],cleanupTimeoutMs=2000,independent=[]){if(!closing){revoke();const drain=async()=>{await life.drain();await Promise.allSettled([...jobs])};closing=settleLegacyCleanup([async()=>{await drain();const outcomes=await Promise.allSettled(tasks.map(fn=>Promise.resolve().then(fn)));const errors=[...lateFailures,...outcomes.filter(x=>x.status==='rejected').map(x=>x.reason)];if(errors.length)throw new AggregateError(errors,label+' resource cleanup failed')},...independent],{timeoutMs:cleanupTimeoutMs,label:label+' cleanup failed'})}return closing}})
}

