/** Explicit terminal-idle / generic-terminal-error subset for exact 2.0.27.
 * Creation is a separate, per-subscription opt-in within this profile.
 * Not a V1 status service, a success receipt, or an event-stream client facade.
 * One instance belongs to one activation/subscription; no state is shared.
 */
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import {cloneFactoryOptions} from './legacy-factory-options.js'
import {V2EventMappingError} from './v2-event-mapper.js'
import {createLegacyEventBatch} from './legacy-event-bridge.js'
const fail=message=>{throw new V2EventMappingError(message)}
const record=(value,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(label+' must be a plain record')
  return value
}
const field=(value,key,required=false)=>{
  const d=Object.getOwnPropertyDescriptor(value,key)
  if(!d){if(required)fail('Missing native field: '+key);return undefined}
  if(!Object.hasOwn(d,'value')||!d.enumerable)fail('Native fields must be enumerable data: '+key)
  return d.value
}
function fields(value,keys,label){record(value,label);for(const key of Reflect.ownKeys(value))if(typeof key!=='string'||!keys.includes(key))fail('Unsupported '+label+' field: '+String(key));return value}
const types=new Set(['session.execution.started','session.execution.succeeded','session.execution.failed','session.execution.interrupted'])
const creationType='session.created'
const sessionId=value=>typeof value==='string'&&/^ses.+/.test(value)
const epoch=value=>Number.isSafeInteger(value)&&value>=0
const sameLocation=(a,b)=>a.directory===b.directory&&a.workspaceID===b.workspaceID
const reasons=new Set(['user','shutdown','superseded','inactivity'])
function locationOf(value){
  fields(value,['directory','workspaceID'],'location')
  const directory=field(value,'directory',true),workspaceID=field(value,'workspaceID')
  if(typeof directory!=='string'||!directory||workspaceID!==undefined&&typeof workspaceID!=='string')fail('Invalid native location')
  return {directory,...(workspaceID!==undefined?{workspaceID}:{})}
}
function creationData(value){
  const data=fields(value,['sessionID','projectID','location','subpath','parentID','slug','title','agent','model','metadata','permissions','version'],'creation data')
  const out={location:locationOf(field(data,'location',true))}
  if(!isAbsolute(out.location.directory))fail('Native creation directory must be absolute')
  for(const key of ['sessionID','projectID','slug','version','subpath','parentID','title','agent']){
    const required=['sessionID','projectID','slug','version'].includes(key)
    const value=field(data,key,required)
    if(value===undefined&&!required)continue
    if(typeof value!=='string'||required&&!value)fail('Invalid native creation '+key)
    out[key]=value
  }
  if(out.parentID!==undefined&&(!sessionId(out.parentID)||out.parentID===out.sessionID))fail('Invalid native creation parentID')
  const model=field(data,'model')
  if(model!==undefined){
    fields(model,['id','providerID','variant'],'creation model')
    out.model={}
    for(const key of ['id','providerID','variant']){
      const value=field(model,key,key!=='variant')
      if(value===undefined&&key==='variant')continue
      if(typeof value!=='string'||!value)fail('Invalid native creation model '+key)
      out.model[key]=value
    }
  }
  const metadata=field(data,'metadata')
  if(metadata!==undefined){
    try{out.metadata=cloneFactoryOptions(metadata)}
    catch(cause){throw new V2EventMappingError('Unsupported native session metadata representation',cause)}
  }
  const permissions=field(data,'permissions')
  if(permissions!==undefined){
    let rules
    try{rules=cloneFactoryOptions({permissions}).permissions}
    catch(cause){throw new V2EventMappingError('Invalid native creation permission rules',cause)}
    if(!Array.isArray(rules))fail('Invalid native creation permission rules')
    for(const rule of rules){
      fields(rule,['action','resource','effect'],'creation permission rule')
      if(typeof field(rule,'action',true)!=='string'||typeof field(rule,'resource',true)!=='string'||
         !['allow','deny','ask'].includes(field(rule,'effect',true)))fail('Invalid native creation permission rule')
    }
    // Keep native rules only for duplicate comparison. They are not V1 rules.
    out.permissions=rules
  }
  return out
}
function snapshot(event){
  fields(event,['id','type','created','durable','data','location','metadata'],'event')
  const id=field(event,'id',true),type=field(event,'type',true),created=field(event,'created',true)
  if(typeof id!=='string'||!/^evt_.+/.test(id)||!Number.isFinite(created))fail('Native event needs actual id and finite created timestamp')
  const creation=type===creationType
  const keys=type==='session.execution.failed'?['sessionID','error']:type==='session.execution.interrupted'?['sessionID','reason']:['sessionID']
  const input=field(event,'data',true)
  const data=creation?creationData(input):fields(input,keys,'execution data')
  const sessionID=field(data,'sessionID',true)
  if(!sessionId(sessionID))fail('Native session event needs sessionID')
  const durable=fields(field(event,'durable',true),['aggregateID','seq','version'],'durable envelope')
  if(field(durable,'aggregateID',true)!==sessionID||!Number.isSafeInteger(field(durable,'seq',true))||durable.seq<0||field(durable,'version',true)!==1)fail('Invalid or unsupported native durable envelope')
  if(creation&&(!epoch(created)||durable.seq!==0))fail('Native creation needs an epoch timestamp and initial sequence')
  const out={id,type,created,durable:{aggregateID:sessionID,seq:durable.seq,version:1},data:creation?data:{sessionID}}
  if(type==='session.execution.interrupted'){
    const reason=field(data,'reason',true);if(!reasons.has(reason))fail('Invalid native interruption reason');out.data.reason=reason
  }
  if(type==='session.execution.failed'){
    const error=fields(field(data,'error',true),['type','message','status','response'],'execution error')
    const kind=field(error,'type',true),message=field(error,'message',true)
    if(typeof kind!=='string'||typeof message!=='string')fail('Invalid native execution error')
    out.data.error={type:kind,message}
    const status=field(error,'status'),response=field(error,'response')
    if(status!==undefined){if(!Number.isInteger(status)||status<100||status>599)fail('Invalid native error status');out.data.error.status=status}
    if(response!==undefined){fields(response,['body'],'error response');if(typeof field(response,'body',true)!=='string')fail('Invalid native error response');out.data.error.response={body:response.body}}
  }
  for(const key of ['location','metadata']){
    const value=field(event,key)
    if(value!==undefined){
      record(value,key)
      if(key==='location')out.location=locationOf(value)
      else try{out.metadata=cloneFactoryOptions(value)}catch(cause){throw new V2EventMappingError('Unsupported native metadata representation',cause)}
    }
  }
  if(creation&&(!out.location||!sameLocation(data.location,out.location)))fail('Native creation envelope and data location must agree')
  return out
}

function projectCreation(event,session){
  const {data,created}=event
  record(session,'Session creation readback')
  const location=locationOf(field(session,'location',true))
  if(field(session,'id',true)!==data.sessionID||field(session,'projectID',true)!==data.projectID||
     !sameLocation(location,data.location)||field(session,'parentID')!==data.parentID)fail('Native creation ownership readback contradicts the event')
  const time=record(field(session,'time',true),'Session creation readback time')
  const original=field(time,'created',true),updated=field(time,'updated',true)
  if(!epoch(original)||!epoch(updated)||updated<original)fail('Invalid native session readback time')
  // Import may overwrite the timestamps in the creation transaction. Moves
  // and other updates advance time.updated; Promise readback redacts workspace.
  // Require the creation-time row rather than projecting a changed session.
  if(original!==created||updated!==created||data.title===undefined)return null
  const info={id:data.sessionID,projectID:data.projectID,directory:data.location.directory,
    slug:data.slug,title:data.title,version:data.version,time:{created,updated:created}}
  for(const [key,value] of Object.entries({parentID:data.parentID,path:data.subpath,agent:data.agent,model:data.model,metadata:data.metadata})){
    if(value!==undefined)info[key]=value
  }
  return {type:creationType,properties:{sessionID:data.sessionID,info:cloneFactoryOptions(info)}}
}

/** checkSession must read supported host ownership, not infer it from an event.
 * isOpen closes admission during asynchronous readback. Already-admitted errors
 * still reject; disposal never turns a real read/callback failure into success.
 */
export function createV2027SessionLifecycleEventMapper({checkSession,isOpen=()=>true,maxEvents=4096,maxSessions=128,includeFailureIdle=false,sessionCreated}={}){
  if(typeof checkSession!=='function'||typeof isOpen!=='function')throw new TypeError('Explicit session ownership and admission bindings required')
  for(const [name,value]of Object.entries({maxEvents,maxSessions}))if(!Number.isSafeInteger(value)||value<1)throw new TypeError(name+' must be a positive safe integer')
  if(typeof includeFailureIdle!=='boolean')throw new TypeError('includeFailureIdle must be boolean')
  if(sessionCreated!==undefined&&(typeof sessionCreated?.accepts!=='function'||typeof sessionCreated?.readSession!=='function')){
    throw new TypeError('Session creation requires explicit location admission and session readback bindings')
  }
  const events=new Map(),sequences=new Map(),counts={mapped:0,duplicates:0,ignored:0}
  let closed=false,tail=Promise.resolve()
  const open=()=>!closed&&isOpen()
  async function project(native){
    if(!open())return null
    const event=snapshot(native),sessionID=event.data.sessionID
    const creation=event.type===creationType
    if(creation){
      const admitted=sessionCreated.accepts({projectID:event.data.projectID,location:{...event.location}})
      if(typeof admitted!=='boolean')fail('Creation location admission must return a boolean')
      if(!admitted){counts.ignored++;return null}
    }
    if(events.has(event.id)){
      if(!isDeepStrictEqual(events.get(event.id),event))fail('Conflicting duplicate native lifecycle event')
      counts.duplicates++;return null
    }
    if(event.durable.seq<=(sequences.get(sessionID)??-1))fail('Reordered or conflicting native lifecycle sequence')
    if(events.size>=maxEvents||!sequences.has(sessionID)&&sequences.size>=maxSessions)fail('Lifecycle capacity exhausted; refusing unsafe dedup eviction')
    let created
    if(creation){
      const session=await sessionCreated.readSession(sessionID,open)
      if(!open())return null
      created=projectCreation(event,session)
    }else{
      const owned=await checkSession(sessionID,open,event.location)
      if(typeof owned!=='boolean')fail('Session ownership binding must return a boolean')
      if(!open())return null
      if(!owned)fail('Native session ownership not confirmed')
    }
    // Snapshot and serialize before readback: caller mutation cannot redirect
    // correlation; independent map calls cannot race duplicate admission.
    if(event.type==='session.execution.failed'&&(event.data.error.type!=='unknown'||Object.keys(event.data.error).length!==2))fail('Unsupported V1 session.error projection: native error category/fields cannot be represented faithfully')
    events.set(event.id,event);sequences.set(sessionID,event.durable.seq)
    if(creation){
      if(created)counts.mapped++
      else counts.ignored++
      return created
    }
    if(event.type==='session.execution.succeeded'){
      counts.mapped++;return {type:'session.idle',properties:{sessionID}}
    }
    if(event.type==='session.execution.failed'){
      const error=event.data.error
      const legacyError={type:'session.error',properties:{sessionID,error:{name:'UnknownError',data:{message:error.message}}}}
      counts.mapped++
      return includeFailureIdle?createLegacyEventBatch([legacyError,{type:'session.idle',properties:{sessionID}}]):legacyError
    }
    counts.ignored++;return null // started and all interruptions are never success/error
  }
  return Object.freeze({
    mapEvent(native){
      if(closed)return Promise.reject(new V2EventMappingError('Session lifecycle mapper is disposed'))
      try{
        record(native,'Native event');const type=field(native,'type',true)
        if(typeof type!=='string'||!type)fail('Native event requires a nonempty type')
        if(!types.has(type)&&!(sessionCreated&&type===creationType)){counts.ignored++;return Promise.resolve(null)}
        // Capture now, before a caller can mutate a queued frame.
        const detached=snapshot(native)
        const job=tail.then(()=>project(detached))
        tail=job.then(()=>{},()=>{}) // returned job retains the original rejection
        return job
      }catch(error){return Promise.reject(error)}
    },
    dispose(){if(closed)return;closed=true;events.clear();sequences.clear()},
    snapshot(){return Object.freeze({...counts,closed,events:events.size,sessions:sequences.size})},
  })
}
