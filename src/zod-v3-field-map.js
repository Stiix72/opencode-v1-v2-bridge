import {isFieldMap,snapshotFieldMap,createFieldMapParser}from'./zod-field-map.js'
import {convertZodV3ToJsonSchema}from'./zod-v3-schema.js'
export const isZodV3FieldMap=fields=>isFieldMap(fields,3)
/** This is a projection descriptor, not a constructed/replacement Zod parser. */
export function convertZodV3FieldMap(fields){
 if(!isZodV3FieldMap(fields))throw new TypeError('Expected Zod v3 tool field map')
 const shape=snapshotFieldMap(fields)
 return convertZodV3ToJsonSchema({_def:{typeName:'ZodObject',shape:()=>shape,unknownKeys:'strip'}})
}
export const parseZodV3FieldMap=(fields,input)=>createFieldMapParser(fields)(input)
