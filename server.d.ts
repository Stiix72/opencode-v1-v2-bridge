export type JSONValue = null | boolean | number | string | JSONValue[] | {[key:string]: JSONValue};
export interface LegacyTarget { readonly id:string; readonly module:string; readonly options?:Readonly<Record<string,JSONValue>>; readonly commands?:readonly string[]; /** Reduced, non-authorizing post-request observation; default disabled. */ readonly pendingPermissionObserver?:boolean; /** Opt in to verified V1 creation events with the session-lifecycle profile. */ readonly sessionCreated?:boolean }
export interface ServerConfiguration {
 readonly version:1; readonly targets:readonly LegacyTarget[]; readonly toolExposure?:'direct'|'code-mode';
 readonly clientOptions?:{readonly responseStyle:'data'; readonly throwOnError:true};
 readonly logging?:'stderr'; readonly events?:'terminal-assistant'|'session-lifecycle'; readonly system?:'session-text'; readonly metadata?:'live-json';
}
export class ServerConfigurationError extends TypeError { constructor(message:string,cause?:unknown) }
export class ServerActivationError extends Error { constructor(message:string,cause?:unknown); readonly cleanupFailed?:boolean }
export interface ServerPlugin { readonly id:string; setup(context:unknown):Promise<()=>Promise<void>> }
export function validateServerOptions(input:unknown):Readonly<ServerConfiguration>;
export function createServerPlugin():ServerPlugin;
declare const plugin:ServerPlugin;
export default plugin;
