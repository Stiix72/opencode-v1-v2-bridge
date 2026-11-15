export interface LegacyEvent {type:string; properties:Record<string,unknown>}
declare const legacyEventBatch: unique symbol
export interface LegacyEventBatch<Event extends LegacyEvent=LegacyEvent> {readonly [legacyEventBatch]:Event}
/** Opaque bounded sequence; one or two validated envelopes, never a native/RPC payload. */
export function createLegacyEventBatch<Event extends LegacyEvent>(events:readonly Event[]):LegacyEventBatch<Event>
export class LegacyEventBridgeError extends Error {constructor(message:string,cause?:unknown)}
export function validateLegacyEvent(event:unknown):LegacyEvent
export function registerLegacyEvents<Event extends LegacyEvent>(
  context:{event:{subscribe(options?:{signal?:AbortSignal}):AsyncIterable<unknown>}},
  handler:(input:{event:Event})=>void|Promise<void>,
  options:{mapEvent:(native:unknown)=>Event|LegacyEventBatch<Event>|null|undefined|Promise<Event|LegacyEventBatch<Event>|null|undefined>;onError?:(error:unknown)=>unknown;disposeMapper?:()=>void;disposeTimeoutMs?:number},
):Promise<{done:Promise<void>;dispose():Promise<void>}>
