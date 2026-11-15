export interface NativePermissionToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly id: string
  readonly signal: AbortSignal
}
export interface LegacyPermissionInput {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}
export interface NativePendingPermission {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly source?: { readonly type: 'tool'; readonly messageID: string; readonly id: string }
}
export type NativePermissionJson = null | boolean | number | string | NativePermissionJson[] | { [key: string]: NativePermissionJson }
export interface NativePermissionClient {
  permission: { create(input: Omit<NativePendingPermission, 'metadata'> & { readonly agent: string; readonly metadata: Readonly<Record<string, NativePermissionJson>> }): Promise<{ readonly id: string; readonly effect: 'allow' | 'deny' | 'ask' }> }
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ readonly type: string; readonly data: unknown }> }
  session: { get(input: { sessionID: string }): Promise<{ readonly id: string; readonly location: { readonly directory: string } }> }
}
export interface NativePermissionControls {
  list(input: { sessionID: string }): Promise<readonly NativePendingPermission[]>
  reply(input: { sessionID: string; requestID: string; decision: 'reject' }): Promise<void>
}
export interface NativePermissionBinding {
  ask(context: NativePermissionToolContext, input: LegacyPermissionInput): Promise<void>
  dispose(): Promise<void>
}
export class LegacyPermissionError extends Error { readonly code: string; constructor(code: string, message: string, cause?: unknown) }
export function snapshotPermissionContext(context: NativePermissionToolContext): Readonly<NativePermissionToolContext>
export function createNativePermissionBinding(options: {
  client: NativePermissionClient
  permission: NativePermissionControls
  locationDirectory: string
  /** Must actually verify public client + plugin controls belong to the same host/location. */
  assertSameHost(input: { sessionID: string; locationDirectory: string }): void | false | Promise<void | false>
  timeoutMs?: number
  cleanupTimeoutMs?: number
  confirmationIntervalMs?: number
}): NativePermissionBinding
