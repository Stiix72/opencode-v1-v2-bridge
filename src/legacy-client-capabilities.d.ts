import type {NativeInputContext,NativePluginInputSubset,LegacyDataClientOptions} from './native-plugin-input.js'
import type {ToastCapability} from './v2-toast-capability.js'
export type ClientJSON=null|string|boolean|number|readonly ClientJSON[]|{readonly[key:string]:ClientJSON}
export interface ClientCapabilityOwner{readonly directory:string;readonly projectID:string;readonly worktree:string;readonly canonical:string;readonly workspaceID?:string}
export interface LegacyLogBody{readonly service:string;readonly level:'debug'|'info'|'warn'|'error';readonly message:string;readonly extra?:Readonly<Record<string,ClientJSON>>}
export interface LegacyToastBody{readonly title?:string;readonly message:string;readonly variant:'info'|'success'|'warning'|'error';readonly duration?:number}
/** Only explicit data/throw results; full generated SDK envelopes and signals are unsupported. */
export interface ClientCapabilityRequest<T>{readonly body:T;readonly query?:{readonly directory?:string};readonly responseStyle?:'data';readonly throwOnError?:true}
export interface LogInvocation{readonly requestID:string;readonly activationID:string;readonly owner:ClientCapabilityOwner;readonly signal:AbortSignal}
/** written acknowledges sink completion, not fsync or durable persistence. */
export interface LogAcknowledgement{readonly requestID:string;readonly activationID:string;readonly owner:ClientCapabilityOwner;readonly status:'written'|'not-written'}
export interface AcknowledgedLogCapability{readonly owner:ClientCapabilityOwner;write(body:LegacyLogBody,invocation:LogInvocation):Promise<LogAcknowledgement>;dispose?():Promise<void>|void}
/** Nonempty snapshots of connected/disabled only. All other states reject the entire result. */
export type RestrictedMcpStatus=Record<string,{status:'connected'}|{status:'disabled'}>
/** Additional failed-server data only; a rejected native request remains a rejection. */
export type FailedAwareMcpStatus=Record<string,{status:'connected'}|{status:'disabled'}|{status:'failed';error:string}>
export interface RestrictedMcpStatusRequest{readonly query?:{readonly directory?:string};readonly responseStyle?:'data';readonly throwOnError?:true;readonly signal?:never}
export interface ClientCapabilityOptions{readonly clientOptions?:LegacyDataClientOptions;readonly logging?:AcknowledgedLogCapability;readonly toast?:ToastCapability;readonly mcpStatus?:'connected-disabled'|'connected-disabled-failed'|false;readonly loggingTimeoutMs?:number;readonly cleanupTimeoutMs?:number}
export interface CapabilityPluginInput<McpResult=RestrictedMcpStatus> extends Omit<NativePluginInputSubset,'client'>{readonly client:NativePluginInputSubset['client']&{readonly app:{log(request:ClientCapabilityRequest<LegacyLogBody>):Promise<boolean>};readonly tui:{showToast(request:ClientCapabilityRequest<LegacyToastBody>):Promise<boolean>};readonly mcp:{status(request?:RestrictedMcpStatusRequest):Promise<McpResult>}}}
/** Missing optional capabilities still reject; type surface does not assert their availability. */
export interface ClientCapabilityResource<McpResult=RestrictedMcpStatus>{readonly input:CapabilityPluginInput<McpResult>;readonly owner:ClientCapabilityOwner;readonly activationID:string;readonly pending:number;readonly inFlight:number;revoke():void;dispose():Promise<void>}
export function createCapabilityLegacyInputResource<Options extends ClientCapabilityOptions>(ctx:NativeInputContext,options:Options):ClientCapabilityResource<'connected-disabled-failed' extends Options['mcpStatus']?FailedAwareMcpStatus:RestrictedMcpStatus>
export function capabilityInputRevocation(resource:unknown):(()=>void)|undefined
export {LegacyClientCapabilityError} from './client-capability-contract.js'

