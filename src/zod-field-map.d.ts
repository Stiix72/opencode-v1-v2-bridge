/** Supported structural subset only. Conversion, not this port, validates kinds. */
export interface OriginalField {parse(input:unknown,params?:any):unknown;readonly _def?:object;readonly def?:object;readonly '~standard'?:{readonly vendor?:string}}
export type OriginalFieldMap=Record<string,OriginalField>;
export function fieldEntries(fields:object,allowUnsafeNames?:boolean):[string,unknown][];
export function fieldVersion(field:unknown):3|4|undefined;
export function isFieldMap(fields:unknown,version:number):fields is OriginalFieldMap;
export function snapshotFieldMap(fields:OriginalFieldMap):Readonly<OriginalFieldMap>;
export function createFieldMapParser(fields:OriginalFieldMap):(input:unknown)=>Record<string,unknown>;
