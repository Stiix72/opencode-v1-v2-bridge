/** Supported subset only; not a declaration of full V1 PluginInput/client parity. */
export interface NativeInputLocation {
  readonly directory:string
  readonly workspaceID?:string
  readonly project:{readonly id:string;readonly directory:string;readonly canonical:string}
}
export interface NativeInputContext {readonly location:NativeInputLocation;readonly vcs?:{readonly get?:()=>Promise<unknown>};readonly tool?:{readonly list?:()=>Promise<readonly {readonly id:string}[]>};readonly agent?:{readonly list?:(input?:{readonly location?:{readonly directory?:string}})=>Promise<unknown>};readonly mcp?:{readonly list?:()=>Promise<unknown>}}
export interface LegacyDataClientOptions {readonly responseStyle?:'data'|'fields';readonly throwOnError?:boolean}
/** Same explicit data/throw profile; supplied signals are rejected, not forwarded. */
export interface LegacyToolIdsOptions extends LegacyDataClientOptions {readonly query?:{readonly directory?:string};readonly signal?:AbortSignal}
/** Empty-list-only discovery. Nonempty V2 records and HTTP/default/error envelopes reject explicitly. */
export interface LegacyAgentsOptions extends LegacyDataClientOptions {readonly query?:{readonly directory?:string};readonly signal?:AbortSignal}
export interface NativePluginInputSubset {
  readonly directory:string
  readonly worktree:string
  readonly project:{readonly id:string;readonly worktree:string;readonly time:never;readonly vcs:never;readonly vcsDir:never}
  readonly serverUrl:never
  readonly $:never
  readonly experimental_workspace:{register(...args:unknown[]):never}
  readonly client:{readonly app:{agents(options?:LegacyAgentsOptions):Promise<[]>};readonly vcs:{get(options?:LegacyDataClientOptions&{readonly query?:{readonly directory?:string};readonly signal?:AbortSignal}):Promise<{branch:string}>};readonly tool:{ids(options?:LegacyToolIdsOptions):Promise<string[]>}}
}
export function createNativeLegacyInputResource(ctx:NativeInputContext,options?:{readonly clientOptions?:LegacyDataClientOptions}):Readonly<{input:NativePluginInputSubset;dispose():Promise<void>;readonly pending:number}>
