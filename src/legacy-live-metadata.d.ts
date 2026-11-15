/** JSON data only; runtime validation additionally rejects -0/nonfinite numbers, accessors and cycles. */
export type LiveJSONValue = null | string | boolean | number | readonly LiveJSONValue[] | { readonly [key: string]: LiveJSONValue }
export type LiveJSONRecord = Readonly<Record<string, LiveJSONValue>>
export interface LiveJSONMetadataBindingOptions {
  readonly profile: 'live-json'
  /** Explicit same-invocation native capability. Settlement is not delivery or persistence. */
  readonly progress: (metadata: LiveJSONRecord) => Promise<void>
}
export interface LegacyLiveMetadataInput {
  /** Any defined string, including empty string, is rejected at runtime. */
  readonly title?: string
  /** Required at runtime; absent/undefined values cannot be projected. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
/** Opt-in live data projection. Bind the exact returned function as metadata in a translated invocation.
 * Direct calls, wrappers and .bind() are unsupported. Create a fresh binding per invocation; sharing/reuse is refused. No V1 title, durable-part, terminal-lifecycle or rendering guarantee. */
export function createToolMetadataBinding(options: LiveJSONMetadataBindingOptions): (input: LegacyLiveMetadataInput) => Promise<void>
/** @internal Claim at invocation entry, even when no metadata is submitted. */
export function claimToolMetadata(callback: (...args: any[]) => any, owner: symbol): void
/** @internal Executor dispatch seam; ordinary callbacks preserve their existing arguments and return. */
export function invokeToolMetadata(callback: (...args: any[]) => any, receiver: unknown, values: any[], assertActive: () => void, owner: symbol): any
