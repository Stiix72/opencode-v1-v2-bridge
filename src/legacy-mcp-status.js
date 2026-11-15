/** Explicit snapshot profiles only. No startup barrier, authentication inference or native mutation. */
import {UnsupportedLegacyAPIError} from './legacy-context.js'
import {record,assertOwner,failure} from './client-capability-contract.js'
const unsupported=message=>{throw new UnsupportedLegacyAPIError('client.mcp.status: '+message)}
const dataProperty=(object,key,label)=>{
  const d=object&&Object.getOwnPropertyDescriptor(object,key)
  if(!d||!Object.hasOwn(d,'value'))throw new TypeError(label+' requires a data property')
  return d.value
}
export function bindRestrictedMcpStatus(ctx,owner,profile){
  if(profile===undefined||profile===false)return undefined
  if(!['connected-disabled','connected-disabled-failed'].includes(profile))throw new TypeError('mcpStatus must be false or an explicit connected-disabled or connected-disabled-failed profile')
  const includeFailed=profile==='connected-disabled-failed'
  if(!Object.hasOwn(ctx,'mcp'))unsupported('public native mcp capability unavailable')
  const domain=dataProperty(ctx,'mcp','Native MCP capability')
  if(domain===undefined||domain===null)unsupported('public native mcp capability unavailable')
  record(domain,'Native MCP capability')
  if(!Object.hasOwn(domain,'list'))unsupported('public native mcp.list capability unavailable')
  const list=dataProperty(domain,'list','Native MCP list')
  if(typeof list!=='function')unsupported('public native mcp.list capability unavailable')
  const assertOwned=()=>{
    assertOwner(ctx,owner)
    if(dataProperty(ctx,'mcp','Native MCP capability')!==domain||dataProperty(domain,'list','Native MCP list')!==list)throw failure('ownership','Native MCP capability identity changed')
  }
  return Object.freeze({
    assertOwned,
    validateRequest(request,defaults){
      const r=record(request??{},'client.mcp.status options',['query','responseStyle','throwOnError','signal'])
      if(r.responseStyle!==undefined&&!['data','fields'].includes(r.responseStyle)||r.throwOnError!==undefined&&typeof r.throwOnError!=='boolean')throw new TypeError('Invalid MCP client result options')
      if(r.signal!==undefined)unsupported('request cancellation unavailable in the native Promise adapter')
      if((r.responseStyle??defaults.responseStyle??'fields')!=='data'||(r.throwOnError??defaults.throwOnError??false)!==true)unsupported('requires explicit responseStyle=data and throwOnError=true; HTTP envelopes unavailable')
      if(r.query!==undefined){record(r.query,'MCP query',['directory']);if(r.query.directory!==undefined&&r.query.directory!==owner.directory)throw failure('ownership','Cross-location MCP request rejected')}
    },
    read(){
      assertOwned()
      const pending=Reflect.apply(list,domain,[])
      if(!pending||typeof pending.then!=='function')throw new TypeError('Native MCP list must return a Promise; Effect contexts require the public Promise adapter')
      return pending
    },
    project(response){
      assertOwned()
      record(response,'Native MCP response',['location','data'])
      const location=dataProperty(response,'location','Native MCP response')
      record(location,'Native MCP response location',['directory'])
      if(dataProperty(location,'directory','Native MCP location')!==owner.directory)throw failure('ownership','Foreign native MCP response location')
      const entries=dataProperty(response,'data','Native MCP response')
      if(!Array.isArray(entries))throw new TypeError('Native MCP response data must be an array')
      if(entries.length===0)unsupported('empty snapshot has no initialization-complete evidence in this restricted profile')
      for(const key of Reflect.ownKeys(entries))if(key!=='length'&&!(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<entries.length))throw new TypeError('Decorated native MCP array unsupported')
      const out={},names=new Set()
      for(let i=0;i<entries.length;i++){
        const slot=Object.getOwnPropertyDescriptor(entries,String(i))
        if(!slot||!slot.enumerable||!Object.hasOwn(slot,'value'))throw new TypeError('Sparse/accessor native MCP array unsupported')
        const entry=record(slot.value,'Native MCP server',['name','status','integrationID'])
        dataProperty(entry,'name','Native MCP server');dataProperty(entry,'status','Native MCP server')
        if(typeof entry.name!=='string'||names.has(entry.name))throw new TypeError('Invalid or duplicate native MCP server name')
        if(entry.name==='__proto__')unsupported('server name __proto__ has no faithful original V1 dictionary projection')
        names.add(entry.name)
        if(entry.integrationID!==undefined&&(typeof entry.integrationID!=='string'||!entry.integrationID))throw new TypeError('Invalid native MCP integration identifier')
        const state=record(entry.status,'Native MCP status',['status','error'])
        dataProperty(state,'status','Native MCP status')
        if(typeof state.status!=='string')throw new TypeError('Missing native MCP status discriminant')
        if(state.status==='failed'||state.status==='needs_auth'){
          if(typeof state.error!=='string')throw new TypeError('Native MCP failure/auth state requires its error string')
          if(state.status==='failed'&&includeFailed){
            Object.defineProperty(out,entry.name,{value:{status:'failed',error:state.error},enumerable:true,writable:true,configurable:true})
            continue
          }
          unsupported('server '+JSON.stringify(entry.name)+' has excluded '+state.status+' state; native error: '+state.error)
        }
        if(state.status==='pending'){record(state,'Native pending status',['status']);unsupported('server '+JSON.stringify(entry.name)+' is pending; no initialization or authorization is inferred')}
        if(state.status!=='connected'&&state.status!=='disabled')unsupported('unknown or excluded native state '+JSON.stringify(state.status)+' for '+JSON.stringify(entry.name))
        record(state,'Native settled MCP status',['status'])
        Object.defineProperty(out,entry.name,{value:{status:state.status},enumerable:true,writable:true,configurable:true})
      }
      return out
    },
  })
}
