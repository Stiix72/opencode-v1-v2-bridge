/** Supported transport is plain finite JSON configuration; runtime rejects richer unknown values. */
export type LegacyFactoryOptions=Record<string,unknown>;
export type LegacyTarget=string|readonly[string,LegacyFactoryOptions];
export interface NativeFactoryOptions {readonly legacyFactoryOptions?:Readonly<Record<string,LegacyFactoryOptions>>;readonly[key:string]:unknown}
export class LegacyFactoryOptionsError extends TypeError {}
export function cloneFactoryOptions(value:LegacyFactoryOptions):LegacyFactoryOptions;
export function legacyTargetName(entry:LegacyTarget):string;
export function snapshotLegacyTargets(targets:readonly LegacyTarget[]):LegacyTarget[];
export function applyNativeFactoryOptions(targets:readonly LegacyTarget[],nativeOptions?:NativeFactoryOptions):LegacyTarget[];
