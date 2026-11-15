/** Opt-in acknowledged V1 data/throw client profile. No default host capability discovery. */
import {randomUUID} from 'node:crypto'
import {createNativeLegacyInputResource} from './native-plugin-input.js'
import {record,ownerOf,sameOwner,assertOwner,requestBody,timeout,clientOperations,failure} from './client-capability-contract.js'
import {inspectToastCapability,claimToastCapability} from './v2-toast-capability.js'
import {bindRestrictedMcpStatus} from './legacy-mcp-status.js'
export {LegacyClientCapabilityError} from './client-capability-contract.js'
const sinkClaims=new WeakSet(),revocations=new WeakMap()
/** Internal entrypoint ownership seam: extra caller resource properties are not interpreted. */
export const capabilityInputRevocation=resource=>revocations.get(resource)
export function createCapabilityLegacyInputResource(ctx,options){
  record(options,'client capability options',['clientOptions','logging','toast','mcpStatus','loggingTimeoutMs','cleanupTimeoutMs']);const defaults={...record(options.clientOptions??{},'clientOptions',['responseStyle','throwOnError'])},owner=ownerOf(ctx),activationID=randomUUID(),deadline=timeout(options.loggingTimeoutMs),cleanupDeadline=timeout(options.cleanupTimeoutMs)
  const sink=options.logging,toast=options.toast
  const mcp=bindRestrictedMcpStatus(ctx,owner,options.mcpStatus)
  if(!sink&&!toast&&!mcp)throw new TypeError('At least one explicit logging/toast/MCP capability required')
  let write,sinkOwner,release
  const checkSink=()=>{if(!sink)return;record(sink,'logging capability',['owner','write','dispose']);record(sinkOwner,'logging owner',Object.keys(owner));if(sink.write!==write||sink.dispose!==release||sink.owner!==sinkOwner||!sameOwner(owner,sinkOwner))throw failure('ownership','Logging capability identity changed')}
  if(sink!==undefined){record(sink,'logging capability',['owner','write','dispose']);sinkOwner=sink.owner;record(sinkOwner,'logging owner',Object.keys(owner));if(!sameOwner(owner,sinkOwner))throw failure('ownership','Logging capability belongs to another owner');if(sinkClaims.has(sink))throw failure('ownership','Logging capability already claimed');write=sink.write;release=sink.dispose;if(typeof write!=='function'||release!==undefined&&typeof release!=='function')throw new TypeError('Logging capability requires write and optional dispose functions')}
  if(toast!==undefined)inspectToastCapability(toast,owner)
  const base=createNativeLegacyInputResource(ctx,{clientOptions:defaults}),toastBinding=toast===undefined?undefined:claimToastCapability(toast,owner);if(sink)sinkClaims.add(sink)
  const check=()=>{assertOwner(ctx,owner);checkSink();toastBinding?.assertActive();mcp?.assertOwned()},operations=clientOperations(check,'Legacy client capabilities')
  const bodyFor=(request,method)=>{operations.assertActive();return requestBody(request,method,defaults,owner)}
  const log=request=>{let body;try{body=bodyFor(request,'app.log')}catch(error){return Promise.reject(error)}return operations.start(signal=>{const requestID=randomUUID(),call=Reflect.apply(write,sink,[body,Object.freeze({requestID,activationID,owner,signal})]);if(!call||typeof call.then!=='function')throw new TypeError('Acknowledged logging sink must return a Promise, not a write-attempt boolean');return call.then(ack=>({ack,requestID}))},({ack,requestID})=>{record(ack,'log acknowledgement',['requestID','activationID','owner','status']);record(ack.owner,'log acknowledgement owner',Object.keys(owner));if(ack.requestID!==requestID||ack.activationID!==activationID||!sameOwner(ack.owner,owner))throw failure('acknowledgement','Uncorrelated logging acknowledgement');if(!['written','not-written'].includes(ack.status))throw failure('acknowledgement','Logging sink must acknowledge written/not-written; submission is insufficient');return ack.status==='written'},deadline)}
  const showToast=request=>{let body;try{body=bodyFor(request,'tui.showToast')}catch(error){return Promise.reject(error)}return operations.start(()=>toastBinding.deliver(body),value=>{if(value!==true)throw failure('acknowledgement','Toast UI acceptance missing');return true})}
  const mcpStatus=request=>{try{operations.assertActive();mcp.validateRequest(request,defaults)}catch(error){return Promise.reject(error)}return operations.start(()=>mcp.read(),value=>mcp.project(value))}
  function wrap(node,prefix=''){const tree=Object.create(null);for(const key of Object.keys(node)){const value=node[key],name=prefix+key;tree[key]=name==='app.log'&&sink?log:name==='tui.showToast'&&toastBinding?showToast:name==='mcp.status'&&mcp?mcpStatus:typeof value==='function'?(...args)=>{try{operations.assertActive();return Promise.resolve(Reflect.apply(value,node,args)).then(result=>{operations.assertActive();return result})}catch(error){return Promise.reject(error)}}:wrap(value,name+'.')}return new Proxy(Object.freeze(tree),{get(target,key){if(Object.hasOwn(target,key))return Reflect.get(target,key);return Reflect.get(node,key)}})}
  const descriptors=Object.getOwnPropertyDescriptors(base.input);descriptors.client={value:wrap(base.input.client),enumerable:true};const input=Object.freeze(Object.create(Object.getPrototypeOf(base.input),descriptors));let closing
  const revoke=()=>{operations.revoke();toastBinding?.revoke()}
  const resource=Object.freeze({input,owner,activationID,revoke,get pending(){return operations.pending+(toastBinding?.pending??0)},get inFlight(){return operations.inFlight},dispose(){if(!closing){revoke();closing=operations.dispose([()=>release?Reflect.apply(release,sink,[]):undefined],cleanupDeadline,[()=>toastBinding?.dispose(),()=>base.dispose()])}return closing}})
  revocations.set(resource,revoke);return resource
}

