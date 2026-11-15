import type{NativeInputContext}from'./native-plugin-input.js'
import type{ClientCapabilityOwner}from'./legacy-client-capabilities.js'
export class LegacyClientCapabilityError extends Error{constructor(code:string,message:string,cause?:unknown);readonly code:string}
export function ownerOf(ctx:NativeInputContext):ClientCapabilityOwner
