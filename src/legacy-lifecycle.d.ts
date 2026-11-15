/** Activation ownership only; this API does not cancel arbitrary JavaScript. */
export type CleanupState='not-attempted'|'pending'|'completed'|'failed';
export interface CleanupOperation {
  readonly index:number;
  readonly operation:string;
  readonly state:CleanupState;
  readonly settlement:CleanupState;
  readonly dependencies:readonly number[];
  readonly children?:readonly CleanupOperation[];
}
export class LegacyLifecycleError extends Error {
  constructor(code:string,message:string,cause?:unknown);
  code:string;
  cleanupDone?:Promise<void>;
  pending?:number[];
  operations?:readonly CleanupOperation[];
  errors?:readonly unknown[];
}
export type CleanupTask=()=>unknown|PromiseLike<unknown>;
export type CleanupPromise=Promise<void>&{readonly cleanupDone:Promise<void>};
export interface CleanupOptions {
  timeoutMs?:number;
  label?:string;
  labels?:readonly string[];
  /** Prior task indices. Dependents wait for real settlement, including after timeout. */
  dependencies?:readonly (readonly number[])[];
}
export interface Lifetime {
  assertActive():void;
  run<T>(callback:()=>T|PromiseLike<T>,options?:{allowDrain?:boolean}):Promise<Awaited<T>>;
  wrap<F extends (...args:any[])=>any>(callback:F,receiver?:unknown,options?:{allowDrain?:boolean}):(...args:Parameters<F>)=>Promise<Awaited<ReturnType<F>>>;
  stop():void;
  readonly stopped:boolean;
  readonly pending:number;
  drain():Promise<void>;
  finish(callback?:CleanupTask):Promise<unknown>;
}
export function lifecycleTimeout(value?:number):number;
export function onceCleanup<T>(callback:()=>T):()=>Promise<Awaited<T>>;
/** A timeout bounds observation, not execution. cleanupDone is diagnostic actual settlement;
 * late completion never changes a previous error or authorizes reactivation. */
export function settleLegacyCleanup(tasks:readonly CleanupTask[],options?:CleanupOptions):CleanupPromise;
export function createLegacyLifetime(label:string):Lifetime;
export interface LegacyOwner {
  readonly lifetime:Lifetime;
  readonly claimed:boolean;
  claim():LegacyOwner;
  close():Promise<unknown>;
  disposeUnclaimed():Promise<unknown>;
}
export function legacyPluginOwner(plugin:object):LegacyOwner;
export function claimLegacyResource(resource:{dispose:CleanupTask}):()=>Promise<unknown>;
export function disposeUnclaimedLegacyPlugins(plugins:readonly object[],options?:CleanupOptions):CleanupPromise;
