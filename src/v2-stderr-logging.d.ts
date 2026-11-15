import type { CleanupPromise } from './legacy-lifecycle.js'
export interface StderrWritable {
  write(chunk:string,callback:(error?:Error|null)=>void):boolean
  on(event:string,listener:(...args:any[])=>void):unknown
  prependListener(event:string,listener:(...args:any[])=>void):unknown
  removeListener(event:string,listener:(...args:any[])=>void):unknown
  listenerCount(event:string):number
  readonly destroyed?:boolean
  readonly closed?:boolean
  readonly writableEnded?:boolean
  readonly writableNeedDrain?:boolean
  readonly errored?:unknown
}
export type StderrLoggerOptions=(
  {stream?:StderrWritable;write?:never}|
  {stream?:never;write:(line:string)=>unknown}
)&{lifecycleTimeoutMs?:number}
export class StderrLogError extends Error {
  constructor(code:string,message:string,cause?:unknown,phase?:string)
  readonly code:string
  readonly phase?:string
  readonly cleanupDone?:Promise<void>
}
export interface StderrLogger {
  /** Writable mode waits for the write callback. Custom mode trusts only its
   * supplied function's return/settlement; neither mode certifies persistence.
   * One unresolved write is admitted; no internal record queue or automatic retry. */
  (request:unknown):Promise<void>&{readonly cleanupDone?:Promise<void>}
  readonly mode:'writable'|'custom'
  readonly pending:number
  /** Stops new records and bounds waiting, never ends/destroys the borrowed stream. */
  dispose():CleanupPromise
}
export function createStderrLegacyLogger(options?:StderrLoggerOptions):StderrLogger
