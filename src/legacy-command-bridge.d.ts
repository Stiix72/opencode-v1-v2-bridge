export interface CommandIdentity { command:string;sessionID:string }
export interface CommandReady extends CommandIdentity { state:'ready';activationID:string;readinessID:string;consumerID:string }
export interface LegacyCommandInput extends CommandIdentity { arguments?:string;[key:string]:unknown }
export interface LegacyCommandPart { type:string;[key:string]:unknown }
export type LegacyCommandHook=(input:LegacyCommandInput,output:{parts:LegacyCommandPart[]})=>Promise<unknown>|unknown
export type CommandDelivery=(output:CommandIdentity&{parts:LegacyCommandPart[]},readiness?:CommandReady)=>Promise<unknown>|unknown
export type CommandReadiness=(identity:Readonly<CommandIdentity>)=>Promise<CommandReady>
/** Associate required readiness with delivery identity. Cannot replace an established check.
 * Adapters that wrap delivery functions must preserve this association. */
export function bindCommandOutputReadiness<T extends Function>(deliver:T,requireReady:CommandReadiness):T
export function commandOutputReadiness(deliver:Function):CommandReadiness|undefined
export class LegacyCommandBridgeError extends Error { constructor(message:string,cause?:unknown) }
export function validateLegacyCommandParts(parts:LegacyCommandPart[]):LegacyCommandPart[]
/** Pure low-level invocation has no output-delivery requirement. */
export function invokeLegacyCommand(hook:LegacyCommandHook,input:LegacyCommandInput,options?:{initialParts?:LegacyCommandPart[]}):Promise<LegacyCommandPart[]>
export function executeAndDeliverLegacyCommand(hook:LegacyCommandHook,input:LegacyCommandInput,options?:{deliver?:CommandDelivery;initialParts?:LegacyCommandPart[]}):Promise<LegacyCommandPart[]>
