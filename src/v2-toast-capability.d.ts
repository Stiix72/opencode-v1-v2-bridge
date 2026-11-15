import type{NativeInputContext}from'./native-plugin-input.js'
import type{ClientCapabilityOwner}from'./legacy-client-capabilities.js'
export interface ToastDescriptor{readonly id:string;readonly activationID:string;readonly recipientID:string;readonly owner:ClientCapabilityOwner;readonly receiptTimeoutMs:number}
export interface PortableToastDefinition{readonly id:string;readonly methods:Readonly<Record<string,{readonly input:object;readonly output:object}>>;readonly events:Readonly<Record<string,{readonly schema:object}>>}
export interface ToastRegistration{readonly events:{emit(name:string,value:unknown):Promise<void>};dispose():Promise<void>}
export interface ToastPromiseContext extends NativeInputContext{readonly rpc:{register(definition:PortableToastDefinition,handlers:Readonly<Record<string,(input:unknown)=>Promise<{accepted:boolean}>>>):Promise<ToastRegistration>}}
declare const capabilityBrand:unique symbol
export interface ToastCapability{readonly[capabilityBrand]:true;readonly descriptor:ToastDescriptor;readonly pending:number;revoke():void;dispose():Promise<void>}
export interface ToastCapabilityOptions{readonly recipientID:string;readonly receiptTimeoutMs?:number;readonly cleanupTimeoutMs?:number}
export function createLegacyToastCapability(ctx:ToastPromiseContext,options:ToastCapabilityOptions):Promise<ToastCapability>
export function createToastRpcDefinition(descriptor:ToastDescriptor):PortableToastDefinition
/** The native TUI public client/location/toast ports are checked at runtime; no native Context is constructed. */
export function createCapabilityToastCompanion(descriptor:ToastDescriptor):Readonly<{id:string;setup(ctx:unknown):Promise<()=>Promise<void>>}>

