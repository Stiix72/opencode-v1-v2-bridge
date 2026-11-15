export interface LegacyToolAttachment { type: 'file'; mime: string; url: string; filename?: string }
export type LegacyToolResult = string | { title?: string; output: string; metadata?: Record<string, any>; attachments?: LegacyToolAttachment[] }
export type NativeLegacyContent = { type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }
export interface NativeLegacyResult { content: string | NativeLegacyContent[]; metadata?: Record<string, any> }
export interface LegacyResultOptions { toolExposure?: 'direct' | 'code-mode' }
export function mapLegacyToolResult(value: unknown, options?: LegacyResultOptions): NativeLegacyResult
export function validateNativeLegacyResult(value: unknown, options?: LegacyResultOptions): NativeLegacyResult
