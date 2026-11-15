/** Public Promise RPC -> selected native TUI. Receipts mean UI acceptance, never painting. */
import {randomUUID} from 'node:crypto'
import {settleLegacyCleanup,onceCleanup} from './legacy-lifecycle.js'
import {UnsupportedLegacyAPIError} from './legacy-context.js'
import {record,jsonCopy,freeze,ownerOf,sameOwner,assertOwner,timeout,clientOperations,failure} from './client-capability-contract.js'
const states=new WeakMap(),string={type:'string'},ownerSchema={type:'object',properties:{directory:string,projectID:string,worktree:string,canonical:string},required:['directory','projectID','worktree','canonical'],additionalProperties:false}
const identity={activationID:string,recipientID:string,consumerID:string,owner:ownerSchema}
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false}),accepted=object({accepted:{type:'boolean'}})
function descriptor(value){record(value,'toast descriptor',['id','activationID','recipientID','owner','receiptTimeoutMs']);for(const k of ['id','activationID','recipientID'])if(typeof value[k]!=='string'||!value[k])throw new TypeError('Toast '+k+' required');if(!value.id.startsWith('opencode-v1-bridge.client-toast.'))throw new TypeError('Unexpected toast endpoint namespace');record(value.owner,'toast owner',Object.keys(ownerSchema.properties));for(const k of ownerSchema.required)if(typeof value.owner[k]!=='string'||!value.owner[k])throw new TypeError('Toast owner '+k+' required');timeout(value.receiptTimeoutMs);return freeze(jsonCopy(value))}
export function createToastRpcDefinition(options){const d=descriptor(options);return freeze({id:d.id,methods:{claim:{input:object(identity),output:accepted},release:{input:object(identity),output:accepted},receipt:{input:object({...identity,deliveryID:string,status:{type:'string',enum:['accepted-by-ui','failed']},error:string},[...Object.keys(identity),'deliveryID','status']),output:accepted}},events:{toast:{schema:object({...identity,deliveryID:string,expiresAt:{type:'integer'},toast:object({title:string,message:string,variant:{type:'string',enum:['info','success','warning','error']},duration:{type:'number'}},['message','variant'])})}}})}
export async function createLegacyToastCapability(ctx,options){
  record(options,'toast capability options',['recipientID','receiptTimeoutMs','cleanupTimeoutMs']);if(typeof options.recipientID!=='string'||!options.recipientID)throw new TypeError('Explicit toast recipientID required')
  const owner=ownerOf(ctx);if(owner.workspaceID!==undefined)throw new UnsupportedLegacyAPIError('Toast workspace ownership: exact public HTTP Location omits workspaceID')
  const rpcOwner=ctx.rpc,register=rpcOwner?.register;if(typeof register!=='function')throw new UnsupportedLegacyAPIError('Public Promise RPC registration')
  const d=descriptor({id:'opencode-v1-bridge.client-toast.'+randomUUID(),activationID:randomUUID(),recipientID:options.recipientID,owner,receiptTimeoutMs:timeout(options.receiptTimeoutMs)}),definition=createToastRpcDefinition(d),cleanupDeadline=timeout(options.cleanupTimeoutMs),pending=new Map(),publications=new Set();let registration,consumer,closed=false,claimed=false,disposing
  const check=()=>{assertOwner(ctx,owner);if(ctx.rpc!==rpcOwner||ctx.rpc?.register!==register)throw failure('ownership','Toast RPC owner changed');if(closed)throw failure('disposed','Toast capability disposed')}
  const operations=clientOperations(check,'Legacy toast')
  const matches=input=>input&&input.activationID===d.activationID&&input.recipientID===d.recipientID&&typeof input.consumerID==='string'&&!!input.consumerID&&sameOwner(input.owner,owner)
  const valid=input=>{try{check();return matches(input)}catch{return false}}
  const handlers={
    async claim(input){if(!valid(input)||consumer)return{accepted:false};consumer=input.consumerID;return{accepted:true}},
    async release(input){if(!valid(input)||consumer!==input.consumerID)return{accepted:false};consumer=undefined;for(const entry of pending.values())entry.reject(failure('consumer-unavailable','Toast consumer released; delivery unconfirmed'));return{accepted:true}},
    async receipt(input){const entry=pending.get(input?.deliveryID);if(!valid(input)||!entry||entry.received||consumer!==input.consumerID||entry.consumerID!==input.consumerID||Date.now()>=entry.expiresAt)return{accepted:false};if(!['accepted-by-ui','failed'].includes(input.status))return{accepted:false};entry.received=true;if(input.status==='failed')entry.reject(failure('delivery',typeof input.error==='string'?input.error:'Native UI acceptance failed'));else entry.resolve(true);return{accepted:true}},
  }
  registration=await Reflect.apply(register,rpcOwner,[definition,handlers]);if(typeof registration?.events?.emit!=='function'||typeof registration?.dispose!=='function'){const errors=[new TypeError('Invalid native RPC registration')];try{await registration?.dispose?.()}catch(e){errors.push(e)}throw new AggregateError(errors,'Toast registration rejected')}
  const emitter=registration.events,emit=emitter.emit,disposeRegistration=registration.dispose,stopRegistration=onceCleanup(()=>Reflect.apply(disposeRegistration,registration,[]));let stopping
  const deliver=toast=>operations.start(async signal=>{
    if(!consumer)throw failure('consumer-unavailable','No selected toast consumer has claimed this activation')
    const consumerID=consumer,deliveryID=randomUUID(),expiresAt=Date.now()+d.receiptTimeoutMs;let resolve,reject;const receipt=new Promise((yes,no)=>{resolve=yes;reject=no});const entry={consumerID,expiresAt,resolve,reject,received:false};pending.set(deliveryID,entry)
    const cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
    const event={activationID:d.activationID,recipientID:d.recipientID,consumerID,owner,deliveryID,expiresAt,toast:jsonCopy(toast)}
    const publication=Promise.resolve().then(()=>{check();if(signal.aborted)throw signal.reason;if(registration.events!==emitter||emitter.emit!==emit||registration.dispose!==disposeRegistration)throw failure('ownership','Toast registration identity changed');return Reflect.apply(emit,emitter,['toast',freeze(event)])})
    publications.add(publication);publication.then(()=>publications.delete(publication),()=>publications.delete(publication))
    try{return await Promise.all([publication,receipt]).then(([,result])=>result)}catch(error){reject(error);throw error}finally{signal.removeEventListener('abort',cancel);pending.delete(deliveryID)}
  },value=>{if(value!==true)throw failure('acknowledgement','Missing native UI acceptance');return true},d.receiptTimeoutMs)
  const revoke=()=>{if(closed)return;closed=true;operations.revoke();consumer=undefined;stopping=stopRegistration();stopping.catch(()=>{})}
  const capability=Object.freeze({descriptor:d,revoke,get pending(){return pending.size},dispose(){if(!disposing){revoke();disposing=operations.dispose([async()=>{await Promise.allSettled([...publications])},()=>stopping??stopRegistration()],cleanupDeadline)}return disposing}})
  states.set(capability,Object.freeze({owner,assertActive:()=>operations.assertActive(),deliver,revoke,dispose:()=>capability.dispose(),deadline:d.receiptTimeoutMs,get claimed(){return claimed},claim(){if(claimed)throw failure('ownership','Toast capability already claimed');check();claimed=true}}))
  return capability
}
export function inspectToastCapability(capability,owner){const state=states.get(capability);if(!state||!sameOwner(state.owner,owner))throw failure('ownership','A real activation-owned toast capability for this owner is required');if(state.claimed)throw failure('ownership','Toast capability already claimed');state.assertActive();return state}
export function claimToastCapability(capability,owner){const state=inspectToastCapability(capability,owner);state.claim();return state}
export function createCapabilityToastCompanion(options){const d=descriptor(options),definition=createToastRpcDefinition(d);return Object.freeze({id:d.id+'.tui',async setup(ctx){
  const client=ctx?.client,ui=ctx?.ui?.toast,show=ui?.show,rpcFactory=client?.rpc,locationApi=client?.location,getLocation=locationApi?.get
  if(typeof show!=='function'||typeof rpcFactory!=='function'||typeof getLocation!=='function')throw new UnsupportedLegacyAPIError('Native TUI toast/RPC/location capabilities')
  const consumerID=randomUUID(),identity={activationID:d.activationID,recipientID:d.recipientID,consumerID,owner:d.owner},rpc=Reflect.apply(rpcFactory,client,[definition]);for(const method of ['claim','receipt','release'])if(typeof rpc?.[method]!=='function')throw new TypeError('Missing toast RPC '+method)
  if(typeof rpc?.events?.on!=='function')throw new TypeError('Toast RPC event subscription unavailable')
  const calls={claim:rpc.claim,receipt:rpc.receipt,release:rpc.release},jobs=new Set(),errors=[],seen=new Map();let closed=false,unsubscribe,closing,leased=false
  const current=()=>ctx.location??ctx.data?.location?.default?.()
  const check=()=>{if(closed)throw failure('disposed','TUI toast consumer disposed');if(current()?.directory!==d.owner.directory||current()?.workspaceID!==undefined)throw failure('ownership','TUI current location is not this toast recipient');if(ctx.client!==client||client.rpc!==rpcFactory||client.location!==locationApi||locationApi.get!==getLocation||ctx.ui?.toast!==ui||ui.show!==show||Object.keys(calls).some(k=>rpc[k]!==calls[k]))throw failure('ownership','Native TUI capability identity changed')}
  const verify=async()=>{check();const location=await Reflect.apply(getLocation,locationApi,[{location:{directory:d.owner.directory}}]);check();if(!sameOwner(ownerOf({location}),d.owner))throw failure('ownership','Native TUI project/location does not match recipient')}
  const requireAccepted=result=>{record(result,'toast RPC acknowledgement',['accepted']);if(result.accepted!==true)throw failure('acknowledgement','Toast receipt/claim was not accepted')}
  const onToast=async event=>{
    const input=event?.data;if(!input||event.location?.directory!==d.owner.directory||event.location?.workspaceID!==undefined||!sameOwner(input.owner,d.owner)||input.activationID!==d.activationID||input.recipientID!==d.recipientID||input.consumerID!==consumerID)return
    check();if(!Number.isSafeInteger(input.expiresAt)||Date.now()>=input.expiresAt)return
    if(typeof input.deliveryID!=='string'||!input.deliveryID)return
    // A duplicate event never shows twice and never changes the recorded outcome.
    for(const[id,entry]of seen)if(entry.expiresAt<=Date.now())seen.delete(id);const prior=seen.get(input.deliveryID);if(prior)return prior.task
    const task=(async()=>{let status='accepted-by-ui',error
      try{await verify();if(Date.now()>=input.expiresAt)throw failure('expired','Toast expired before UI acceptance');const body=record(input.toast,'native toast',['message','variant','title','duration']);if(typeof body.message!=='string'||!['info','success','warning','error'].includes(body.variant)||body.title!==undefined&&typeof body.title!=='string'||body.duration!==undefined&&(typeof body.duration!=='number'||!Number.isFinite(body.duration)))throw new TypeError('Malformed native toast');const result=Reflect.apply(show,ui,[jsonCopy(body)]);if(result!==undefined){if(result&&typeof result.then==='function')await result;throw new TypeError('Native Toast.show must return void, not a Promise/result')};check()}catch(cause){status='failed';error=cause instanceof Error?cause.message:String(cause)}
      const receipt={...identity,deliveryID:input.deliveryID,status,...(error===undefined?{}:{error})};requireAccepted(await Reflect.apply(calls.receipt,rpc,[receipt,{location:{directory:d.owner.directory}}]))
    })();seen.set(input.deliveryID,{task,expiresAt:input.expiresAt});return task
  }
  const tracked=event=>{const job=onToast(event);jobs.add(job);job.then(()=>jobs.delete(job),error=>{jobs.delete(job);errors.push(error)});return job}
  try{await verify();unsubscribe=rpc.events.on('toast',tracked);if(typeof unsubscribe!=='function')throw new TypeError('Toast subscription must return cleanup');requireAccepted(await Reflect.apply(calls.claim,rpc,[identity,{location:{directory:d.owner.directory}}]));leased=true;check()}catch(error){closed=true;const failures=[error];try{unsubscribe?.()}catch(cleanup){failures.push(cleanup)}if(leased)try{requireAccepted(await Reflect.apply(calls.release,rpc,[identity,{location:{directory:d.owner.directory}}]))}catch(cleanup){failures.push(cleanup)}if(failures.length>1)throw new AggregateError(failures,'Toast setup and cleanup failed');throw error}
  return()=>{if(!closing){closed=true;closing=settleLegacyCleanup([async()=>{try{unsubscribe()}catch(error){errors.push(error)}try{requireAccepted(await Reflect.apply(calls.release,rpc,[identity,{location:{directory:d.owner.directory}}]))}catch(error){errors.push(error)}await Promise.allSettled([...jobs]);seen.clear();if(errors.length)throw new AggregateError(errors,'Toast consumer cleanup failed')}],{timeoutMs:d.receiptTimeoutMs,label:'Toast consumer cleanup incomplete'})}return closing}
}})}


