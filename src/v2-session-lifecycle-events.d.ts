import type {LegacyEventBatch} from './legacy-event-bridge.js'
export interface SessionLifecycleMapperOptions {
  readonly checkSession: (sessionID: string, isOpen: () => boolean, location?: Readonly<{directory:string; workspaceID?:string}>) => Promise<boolean> | boolean
  readonly isOpen?: () => boolean
  readonly maxEvents?: number
  readonly maxSessions?: number
  /** Public session-lifecycle profile opts in; low-level default remains single-event. */
  readonly includeFailureIdle?: boolean
  readonly sessionCreated?: SessionCreatedBindings
}
export interface SessionCreatedBindings {
  readonly accepts: (owner: Readonly<{projectID:string; location:Readonly<{directory:string; workspaceID?:string}>}>) => boolean
  readonly readSession: (sessionID: string, isOpen: () => boolean) => Promise<unknown> | unknown
}
type SessionMetadata = null | boolean | number | string | SessionMetadata[] | {[key:string]:SessionMetadata}
export type LegacySessionCreatedEvent = {
  type: 'session.created'
  properties: {
    sessionID: string
    info: {
      id: string; projectID: string; directory: string; title: string; slug: string; version: string
      time: {created:number; updated:number}
      parentID?: string; path?: string; agent?: string
      model?: {id:string; providerID:string; variant?:string}
      metadata?: {[key:string]:SessionMetadata}
    }
  }
}
export type LegacySessionLifecycleEvent =
  | {type: 'session.idle'; properties: {sessionID: string}}
  | {type: 'session.error'; properties: {sessionID: string; error: {name: 'UnknownError'; data: {message: string}}}}
export interface SessionLifecycleMapper<Result> {
  mapEvent(native: unknown): Promise<Result | null>
  dispose(): void
  /** mapped counts native frames, not the number of callbacks in a batch. */
  snapshot(): Readonly<{mapped:number; duplicates:number; ignored:number; closed:boolean; events:number; sessions:number}>
}
type TerminalResult = LegacySessionLifecycleEvent | LegacyEventBatch<LegacySessionLifecycleEvent>
export function createV2027SessionLifecycleEventMapper(options: SessionLifecycleMapperOptions & {includeFailureIdle:true; sessionCreated?:undefined}): SessionLifecycleMapper<TerminalResult>
export function createV2027SessionLifecycleEventMapper(options: SessionLifecycleMapperOptions & {includeFailureIdle?:false; sessionCreated?:undefined}): SessionLifecycleMapper<LegacySessionLifecycleEvent>
export function createV2027SessionLifecycleEventMapper(options: SessionLifecycleMapperOptions & {includeFailureIdle?:false; sessionCreated:SessionCreatedBindings}): SessionLifecycleMapper<LegacySessionLifecycleEvent | LegacySessionCreatedEvent>
export function createV2027SessionLifecycleEventMapper(options: SessionLifecycleMapperOptions & {sessionCreated?:undefined}): SessionLifecycleMapper<TerminalResult>
export function createV2027SessionLifecycleEventMapper(options: SessionLifecycleMapperOptions): SessionLifecycleMapper<TerminalResult | LegacySessionCreatedEvent>
