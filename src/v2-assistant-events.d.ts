/** Deliberate terminal-message subset, not the full V1 SDK Message.Info. */
export interface NativeMappingDiagnostic { readonly type: string; readonly reason: string }
export interface AssistantMappingOptions {
  maxSessions?: number
  maxMessagesPerSession?: number
  /** Synchronous diagnostic sink. Without one, unsupported mappings throw. */
  onUnsupported?: (diagnostic: NativeMappingDiagnostic) => void
}
export type LegacyMappedEvent = {
  type: 'session.created'
  properties: Record<string, unknown>
} | {
  type: 'message.updated'
  properties: {
    info: {
      id: string; sessionID: string; role: 'assistant'; time: { completed: number }
      finish: string; error?: { type: string; message: string }; cost?: number
      tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    }
    bridge: { native: Record<string, unknown> }
  }
}
export interface AssistantEventMapper {
  mapEvent(event: unknown): LegacyMappedEvent | null
  dispose(): void
  snapshot(): Readonly<{
    mapped: number; duplicate: number; ignored: number; unsupported: number
    closed: boolean; sessions: number; messages: number; tombstones: number
  }>
}
export function createV2027AssistantEventMapper(options?: AssistantMappingOptions): AssistantEventMapper
