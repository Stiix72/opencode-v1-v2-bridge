export interface LegacyToolHookIdentity { readonly tool: string; readonly sessionID: string; readonly callID: string }
export interface LegacyToolHookContract {
  'tool.execute.before'?: (input: LegacyToolHookIdentity, output: { args: any }) => Promise<void>
  'tool.execute.after'?: (input: LegacyToolHookIdentity & { readonly args: any }, output: { title: string; output: string; metadata: any }) => Promise<void>
}
export interface NativeToolHookIdentity { readonly tool: string; readonly sessionID: string; readonly agent: string; readonly messageID: string; readonly id: string }
export interface NativeToolHookResult {
  readonly output?: unknown
  readonly content?: string | readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'file'; readonly uri: string; readonly mime: string; readonly name?: string })[]
  readonly metadata?: Readonly<Record<string, any>>
}
export interface NativeToolHookEvents {
  'execute.before': NativeToolHookIdentity & { input: unknown }
  'execute.after': NativeToolHookIdentity & { readonly input: unknown } & ({ readonly status: 'completed'; result: NativeToolHookResult } | { readonly status: 'error'; error: unknown })
}
export interface NativeToolHookPort {
  list(): Promise<readonly { readonly id: string; readonly name: string; readonly output?: unknown; readonly options?: { readonly codemode?: boolean } }[]>
  hook<Name extends keyof NativeToolHookEvents>(name: Name, callback: (event: NativeToolHookEvents[Name]) => Promise<void>): Promise<{ dispose(): Promise<void> }>
}
export class LegacyToolHookError extends Error {
  readonly code: string
  readonly phase: string
  readonly plugin?: string
  constructor(code: string, phase: string, plugin?: string, cause?: unknown)
}
export const CODE_MODE_GATEWAY_NAME: 'execute'
/** Bridge metadata convention, not a native title/painting API. */
export const LEGACY_TITLE_METADATA_KEY: 'opencodeV1Bridge'
export function registerLegacyToolHooks(ctx: { tool: NativeToolHookPort }, plugins: readonly { id?: string; target?: string; hooks: LegacyToolHookContract }[]): Promise<{ dispose(): Promise<void> }>
