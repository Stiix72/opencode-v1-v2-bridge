/**
 * Readiness precedes applicable command hooks; it never confirms delivery.
 * No response is indeterminate, not proof of a particular network failure.
 * Receipts still settle once under an independent monotonic delivery deadline.
 */
import type { CleanupPromise } from './legacy-lifecycle.js'
import type { CommandIdentity, CommandReady } from './legacy-command-bridge.js'
export type ReceiptStatus = 'displayed' | 'retained' | 'failed'
export interface OutputSelection extends Omit<CommandReady,'state'> { directory:string; workspaceID?:string }
export interface OutputReceipt { deliveryID: string; status: ReceiptStatus; error?: string; selection?:OutputSelection }
export interface OutputRequest { sessionID: string; command: string; parts: Array<{type: 'text'; text: string}> }
export type DeliveryResult = {status:'empty'} | {status:'displayed'|'retained';deliveryID:string}
export interface OutputRevision { (): number }
export type RevisionFactory = () => [OutputRevision, (update:(value:number)=>number)=>unknown]
export interface ReadinessRequest extends CommandIdentity { activationID:string;readinessID:string;directory:string;workspaceID?:string;selectedOutput?:boolean }
export interface ReadinessResponse extends CommandIdentity { activationID:string;readinessID:string;consumerID:string;selectedOutput?:boolean;state:'ready'|'unavailable';error?:string }
type ObjectSchema = {readonly type:'object';readonly properties:Readonly<Record<string,unknown>>;readonly required:readonly string[];readonly additionalProperties:false}
export const confirmedOutputRpcDefinition: {
 readonly id: 'opencode-v1-bridge.command-output-confirmed'
 readonly methods:{
  readonly readiness:{readonly input:ObjectSchema;readonly output:ObjectSchema}
  readonly receipt:{readonly input:ObjectSchema;readonly output:ObjectSchema}
 }
 readonly events:{readonly output:{readonly schema:ObjectSchema};readonly readiness:{readonly schema:ObjectSchema};readonly selectedOutput:{readonly schema:ObjectSchema}}
}
export interface ConfirmedRegistration {
 events:{
  emit(name:'output',data:{deliveryID:string;sessionID:string;command:string;text:string;activationID?:string}):Promise<void>
  emit(name:'readiness',data:ReadinessRequest):Promise<void>
  emit(name:'selectedOutput',data:{deliveryID:string;text:string;selection:OutputSelection;expiresAt:number}):Promise<void>
 }
 dispose():Promise<void>
}
export interface ConfirmedOutputContext {
 location?:{directory:string;workspaceID?:string}
 rpc:{register(definition:typeof confirmedOutputRpcDefinition, handlers:{
  receipt(input:OutputReceipt):Promise<{accepted:boolean}>
  readiness(input:ReadinessResponse):Promise<{accepted:boolean}>
 }):Promise<ConfirmedRegistration>}
}
export function registerConfirmedCommandOutput(ctx:ConfirmedOutputContext, options?:{receiptTimeoutMs?:number;lifecycleTimeoutMs?:number}):Promise<{
 /** Fresh bounded challenge per invocation. The public HTTP RPC requires a native directory without a workspace.
  * Use the exact evidence once for the same command and session. Readiness does not reserve UI resources. */
 assertReady(identity:CommandIdentity):Promise<CommandReady>
 deliver(request:OutputRequest,readiness?:CommandReady):Promise<DeliveryResult>
 dispose():CleanupPromise
}>
