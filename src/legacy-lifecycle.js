/** Per-activation ownership, not a replacement for host scopes or cancellation. */
import { performance } from 'node:perf_hooks'
export class LegacyLifecycleError extends Error {
  constructor(code, message, cause) { super(message, {cause}); this.name='LegacyLifecycleError'; this.code=code }
}
export function lifecycleTimeout(value=2000) {
  if(!Number.isSafeInteger(value)||value<1)throw new TypeError('lifecycleTimeoutMs must be a positive integer')
  return value
}
export function onceCleanup(callback) {
  let closing
  return ()=>closing??=(Promise.resolve().then(callback))
}
/** Begin every independent task. A deadline reports uncertainty, never success.
 * cleanupDone retains the real outcome, including failures arriving after timeout. */
const cleanupProgress = new WeakMap()
export function settleLegacyCleanup(tasks,{timeoutMs=2000,label='Legacy bridge cleanup failed',labels,dependencies}={}) {
  lifecycleTimeout(timeoutMs)
  if(!Array.isArray(tasks)||Array.from(tasks).some(task=>typeof task!=='function'))throw new TypeError('Cleanup tasks must be functions')
  if(labels!==undefined&&(!Array.isArray(labels)||labels.length!==tasks.length||Array.from(labels).some(name=>typeof name!=='string'||!name)))throw new TypeError('Cleanup labels must name every task')
  const after=dependencies??tasks.map(()=>[])
  if(!Array.isArray(after)||after.length!==tasks.length||Array.from(after).some((list,index)=>!Array.isArray(list)||new Set(list).size!==list.length||Array.from(list).some(value=>!Number.isInteger(value)||value<0||value>=index)))throw new TypeError('Cleanup dependencies must refer to earlier tasks')
  const deadlineAt=performance.now()+timeoutMs
  const pending=new Set(tasks.map((_,i)=>i))
  const records=tasks.map((_,index)=>({index,operation:labels?.[index]??'cleanup task '+index,state:'not-attempted',settlement:'not-attempted'}))
  const snapshot=(actual=false,seen=new Set())=>Object.freeze(records.map(record=>{
    const child=cleanupProgress.get(record.returned)
    const children=child&&!seen.has(record.returned)?child(actual,new Set([...seen,record.returned])):undefined
    return Object.freeze({
      index:record.index,operation:record.operation,state:actual?record.settlement:record.state,
      settlement:record.settlement,dependencies:Object.freeze([...after[record.index]]),
      ...(children?{children}:{}),
    })
  }))
  const actualJobs=[],jobs=[]
  let actualDone
  for(let index=0;index<tasks.length;index++){
    const record=records[index]
    let returned
    const enter=()=>{record.state='pending';record.settlement='pending';returned=tasks[index]();record.returned=returned;return returned}
    // Dependent registration disposal waits for real completion, not a timeout.
    const invoked=after[index].length?Promise.allSettled(after[index].map(i=>actualJobs[i])).then(enter):Promise.resolve().then(enter)
    const actual=invoked.then(
      ()=>returned?.cleanupDone,
      error=>{const completion=returned?.cleanupDone??error?.cleanupDone;if(completion)return completion;throw error},
    ).then(()=>{record.settlement='completed'},error=>{record.settlement='failed';throw error})
    actualJobs.push(actual)
    jobs.push(invoked.then(async()=>{if(returned?.cleanupDone)await returned.cleanupDone}).then(
      ()=>{record.state='completed'},
      error=>{record.state='failed';record.error=error;throw error},
    ).finally(()=>pending.delete(index)))
  }
  const aggregate=(outcomes,actual=false)=>{
    const failures=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason)
    if(!failures.length)return
    const error=new AggregateError(failures,label)
    error.operations=snapshot(actual)
    if(!actual)error.cleanupDone=actualDone
    throw error
  }
  actualDone=Promise.allSettled(actualJobs).then(outcomes=>aggregate(outcomes,true))
  // Observe late failures without replacing the inspectable rejecting promise.
  actualDone.catch(()=>{})
  const timeoutError=()=>{
    const error=new LegacyLifecycleError('cleanup-timeout',label+': cleanup deadline exceeded after '+timeoutMs+'ms ('+pending.size+' reporting tasks pending)')
    error.cleanupDone=actualDone;error.pending=[...pending];error.operations=snapshot()
    error.errors=Object.freeze(records.filter(record=>record.state==='failed').map(record=>record.error))
    return error
  }
  const done=Promise.allSettled(jobs).then(async outcomes=>{
    if(performance.now()>=deadlineAt)throw timeoutError()
    aggregate(outcomes)
    await actualDone
    if(performance.now()>=deadlineAt)throw timeoutError()
  })
  let timer
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError()),timeoutMs)})
  const closing=Promise.race([done,deadline]).finally(()=>clearTimeout(timer))
  Object.defineProperty(closing,'cleanupDone',{value:actualDone})
  cleanupProgress.set(closing,snapshot)
  return closing
}
/** Gate new work and retain actual callback promises until they settle.
 * No synthetic abort signal, false cancellation, polling or forced process exit. */
export function createLegacyLifetime(label) {
  let stopped=false,closing
  const active=new Set(),idle=new Set()
  const assertActive=()=>{if(stopped)throw new LegacyLifecycleError('disposed',`${label}: activation disposed`)}
  const run=(callback,{allowDrain=false}={})=>{
    if(stopped)return Promise.reject(new LegacyLifecycleError('disposed',`${label}: activation disposed`))
    const job=Promise.resolve().then(()=>{assertActive();return callback()}).then(value=>{if(!allowDrain)assertActive();return value})
    active.add(job)
    const remove=()=>{active.delete(job);if(!active.size){for(const resolve of idle)resolve();idle.clear()}}
    job.then(remove,remove)
    return job
  }
  const drain=()=>active.size?new Promise(resolve=>idle.add(resolve)):Promise.resolve()
  return Object.freeze({assertActive,run,wrap:(fn,owner,options)=>(...args)=>run(()=>Reflect.apply(fn,owner,args),options),
    stop(){stopped=true},get stopped(){return stopped},get pending(){return active.size},drain,
    finish(callback=()=>{}){if(!closing){stopped=true;closing=drain().then(callback)}return closing},
  })
}
const owners=new WeakMap(),resourceClaims=new WeakSet()
function disposal(hooks) {
  if(!hooks||typeof hooks!=='object')return undefined
  for(let current=hooks;current;current=Object.getPrototypeOf(current)){
    const d=Object.getOwnPropertyDescriptor(current,'dispose')
    if(!d)continue
    if(!Object.hasOwn(d,'value'))throw new TypeError('Legacy dispose must be a data property, not an accessor')
    if(d.value!==undefined&&typeof d.value!=='function')throw new TypeError('Legacy dispose must be a function')
    return d.value
  }
}
/** Each initialized RECORD is a lifetime; module caching is not state cloning.
 * A claimed record cannot be activated twice. A new factory call makes a new record. */
export function legacyPluginOwner(plugin) {
  if(!plugin||typeof plugin!=='object')throw new TypeError('Legacy plugin record required')
  let owner=owners.get(plugin)
  if(owner)return owner
  const hooks=plugin.hooks,dispose=disposal(hooks),lifetime=createLegacyLifetime(String(plugin.id??plugin.target??'legacy plugin'))
  let claimed=false
  const close=()=>lifetime.finish(()=>dispose?Reflect.apply(dispose,hooks,[]):undefined)
  owner=Object.freeze({lifetime,claim(){if(claimed||lifetime.stopped)throw new LegacyLifecycleError('ownership','Legacy plugin record is already claimed or disposed');claimed=true;return owner},
    close,get claimed(){return claimed},
    disposeUnclaimed(){return claimed?Promise.resolve():close()},
  })
  owners.set(plugin,owner)
  return owner
}
/** Consume an exclusively transferred resource. Never dispose a rejected foreign claim. */
export function claimLegacyResource(resource) {
  if(!resource||typeof resource!=='object'||typeof resource.dispose!=='function')throw new TypeError('Owned resource requires dispose')
  if(resourceClaims.has(resource))throw new LegacyLifecycleError('ownership','Stateful resource already claimed; supply a fresh per-activation resource')
  resourceClaims.add(resource)
  return onceCleanup(()=>resource.dispose())
}
export function disposeUnclaimedLegacyPlugins(plugins,options) {
  return settleLegacyCleanup(plugins.slice().reverse().map(plugin=>()=>legacyPluginOwner(plugin).disposeUnclaimed()),options)
}