/**
 * Backwards-compatible name for the original opt-in message.updated adapter.
 * No personality-specific behavior is implemented here: all logic lives in
 * the generic event mapper and can be reused by any legacy plugin.
 */
import { mapV2MessageUpdated, V2EventMappingError } from './v2-event-mapper.js'
export { V2EventMappingError as PersonalityEventMappingError }
export const mapV2PersonalityEvent = mapV2MessageUpdated
