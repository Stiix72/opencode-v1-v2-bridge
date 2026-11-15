import type { CleanupPromise } from './legacy-lifecycle.js'
export interface LegacyToastBody {
  message:string; title?:string; variant?:'info'|'success'|'warning'|'error'; duration?:number; sessionID?:string
}
export interface ToastLocation { readonly directory:string; readonly workspaceID?:string }
export interface ToastRpcRegistration {
  readonly events:{emit(name:string,data:unknown):Promise<void>|void}
  dispose():unknown
}
export interface ToastRpcContext {
  readonly location?:ToastLocation
  readonly rpc:{register(definition:unknown,handlers:Record<string,(input:any)=>Promise<unknown>>):Promise<ToastRpcRegistration>}
}
export interface ToastTransportOptions {
  log:(request:unknown)=>unknown
  lifecycleTimeoutMs?:number
  toastReceiptTimeoutMs?:number
}
export const LEGACY_CLIENT_RPC_ID:'opencode-v1-bridge.legacy-client'
export const legacyClientRpcDefinition:Readonly<{id:typeof LEGACY_CLIENT_RPC_ID;methods:Readonly<Record<'describe'|'claim'|'release'|'receipt',unknown>>;events:Readonly<{toast:unknown}>}>
export function validateLegacyToast(request:unknown):LegacyToastBody
export function registerLegacyClientTransport(ctx:ToastRpcContext,options:ToastTransportOptions):Promise<{
  readonly client:{
    readonly app:{log(request:unknown):Promise<unknown>}
    /** True is correlated native UI API acceptance, not terminal painting or durable presentation.
     * Rejection/timeout never implies cancellation or rollback of unrelated work. */
    readonly tui:{showToast(request:{body:LegacyToastBody}):Promise<boolean>}
  }
  dispose():CleanupPromise
}>
export function createLegacyClientTuiCompanion(options?:{lifecycleTimeoutMs?:number}):{
  readonly id:string
  setup(ctx:unknown):Promise<()=>CleanupPromise>
}
