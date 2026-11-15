/** Conservative V4 raw-shape projection. Original fields remain authoritative. */
import {isFieldMap,fieldEntries,createFieldMapParser}from'./zod-field-map.js'
export const isZodV4FieldMap=fields=>isFieldMap(fields,4)
function enumSchema(entries){
 const pairs=fieldEntries(entries,true),numeric=pairs.map(([,v])=>v).filter(v=>typeof v==='number')
 // Exact Zod 4 getEnumValues rule filters TypeScript numeric reverse mappings.
 const values=[...new Set(pairs.filter(([key])=>!numeric.includes(+key)).map(([,value])=>value))]
 if(!values.length||values.some(value=>!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)))throw new TypeError('Unsupported or empty Zod v4 enum values')
 const types=[...new Set(values.map(value=>typeof value))]
 return{type:types.length===1?types[0]:types,enum:values}
}
function convert(node,seen=new Set()){
 const def=node?.def
 if(!def||typeof node.parse!=='function')throw new TypeError('Expected a Zod v4 field')
 if(seen.has(node))throw new TypeError('Recursive Zod v4 schemas are unsupported')
 seen.add(node)
 try{
  if(def.check!==undefined||def.format!==undefined)throw new TypeError('Unsupported Zod v4 format/check specialization')
  if(def.coerce===true)throw new TypeError('Unsupported Zod v4 coercion')
  if(def.checks!==undefined&&(!Array.isArray(def.checks)||def.checks.length))throw new TypeError('Unsupported Zod v4 checks on '+def.type)
  switch(def.type){
   case 'optional':return convert(def.innerType,seen)
   case 'string':return{type:'string'}
   case 'boolean':return{type:'boolean'}
   case 'number':return{type:'number'}
   case 'enum':return enumSchema(def.entries)
   case 'array':return{type:'array',items:convert(def.element,seen)}
   case 'object':{
    if(def.catchall!==undefined&&def.catchall?.def?.type!=='never')throw new TypeError('Unsupported Zod v4 passthrough/catchall semantics')
    const properties={},required=[]
    for(const [name,child]of fieldEntries(def.shape)){
     properties[name]=convert(child,seen)
     if(child.def.type!=='optional')required.push(name)
    }
    return{type:'object',properties,required,additionalProperties:false}
   }
   default:throw new TypeError('Unsupported Zod v4 field type: '+def.type)
  }
 }finally{seen.delete(node)}
}
export function convertZodV4FieldMap(fields){
 if(!isZodV4FieldMap(fields))throw new TypeError('Expected Zod v4 tool field map')
 const properties={},required=[]
 for(const [name,field]of fieldEntries(fields)){
  properties[name]=convert(field)
  if(field.def.type!=='optional')required.push(name)
 }
 return{type:'object',properties,required,additionalProperties:false}
}
export const parseZodV4FieldMap=(fields,input)=>createFieldMapParser(fields)(input)
