/** Shared terminal-assistant -> V1 message.updated subset.
 * Opt in with bindings.createEventMapper: () => createV2027AssistantEventMapper()
 * and an explicit bindings.onEventError reporter.
 * One instance belongs to one subscription. This is not full V1 event emulation.
 */
import { V2EventMappingError } from './v2-event-mapper.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const finishes = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'])
const ignored = new Set([
  'session.step.started', 'session.step.first-token', 'session.step.streamed',
  'session.text.started', 'session.text.delta', 'session.text.ended',
  'session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended',
  'session.tool.input.started', 'session.tool.input.delta', 'session.tool.input.ended',
  'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed',
  'session.retry.scheduled',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted', 'session.message.content.updated',
])

function fail(message) { throw new V2EventMappingError(message) }
function validateEnvelope(event, version) {
  if (!/^evt_.+/.test(event.id ?? '') || !finite(event.created) || !record(event.data)) {
    fail('Native event requires id, finite created timestamp and data object')
  }
  const { sessionID } = event.data
  const durable = event.durable
  if (typeof sessionID !== 'string' || !sessionID.startsWith('ses') || !record(durable) ||
      durable.aggregateID !== sessionID || !Number.isSafeInteger(durable.seq) || durable.seq < 0 ||
      durable.version !== version) fail('Invalid or unsupported native session durable envelope')
  if (event.metadata !== undefined && !record(event.metadata)) fail('Invalid native event metadata')
  return sessionID
}

function validateTerminal(data, failed) {
  if (typeof data.assistantMessageID !== 'string' || !/^msg_.+/.test(data.assistantMessageID)) {
    fail('Terminal assistant event requires assistantMessageID')
  }
  if (failed) {
    if (!record(data.error) || typeof data.error.type !== 'string' || typeof data.error.message !== 'string') {
      fail('Failed assistant event requires a native error')
    }
    if (data.finish !== undefined && data.finish !== 'content-filter') fail('Unsupported failed finish reason')
  } else if (!finishes.has(data.finish) || !finite(data.cost) || !record(data.tokens)) {
    fail('Ended assistant event requires finish, cost and tokens')
  }
  if (data.cost !== undefined && !finite(data.cost)) fail('Invalid native cost')
  if (data.tokens !== undefined && (!record(data.tokens) ||
      !['input', 'output', 'reasoning'].every(key => finite(data.tokens[key])) ||
      !record(data.tokens.cache) || !finite(data.tokens.cache.read) || !finite(data.tokens.cache.write))) {
    fail('Invalid native token usage')
  }
  if (data.rawFinish !== undefined && typeof data.rawFinish !== 'string') fail('Invalid native raw finish')
}

/** Unknown mappings throw unless an explicit diagnostic callback accepts them.
 * Capacity exhaustion also throws: never evict a dedup key and replay side effects.
 * Deleted-session tombstones count toward maxSessions and reject late events.
 */
export function createV2027AssistantEventMapper({
  maxSessions = 128, maxMessagesPerSession = 1024, onUnsupported,
} = {}) {
  for (const [name, value] of Object.entries({ maxSessions, maxMessagesPerSession })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (onUnsupported !== undefined && typeof onUnsupported !== 'function') throw new TypeError('onUnsupported must be a function')
  const sessions = new Map()
  const counts = { mapped: 0, duplicate: 0, ignored: 0, unsupported: 0 }
  let closed = false
  const session = id => {
    if (!sessions.has(id)) {
      if (sessions.size >= maxSessions) fail('Assistant event session capacity exhausted; refusing unsafe eviction')
      sessions.set(id, { lastSeq: -1, messages: new Set(), created: false, deleted: false })
    }
    return sessions.get(id)
  }
  const skip = kind => { counts[kind]++; return null }
  return Object.freeze({
    mapEvent(event) {
      if (closed) fail('Assistant event mapper is disposed')
      if (!record(event) || typeof event.type !== 'string' || !event.type) fail('Native event requires a type')
      if (ignored.has(event.type)) return skip('ignored')
      const failed = event.type === 'session.step.failed'
      const terminal = failed || event.type === 'session.step.ended'
      if (!terminal && event.type !== 'session.created' && event.type !== 'session.deleted') {
        counts.unsupported++
        const diagnostic = Object.freeze({ type: event.type, reason: 'No V1 mapping is implemented' })
        if (!onUnsupported) fail(`Unsupported native event mapping: ${event.type}`)
        const result = onUnsupported(diagnostic)
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => {})
          fail('onUnsupported must complete synchronously')
        }
        return null
      }
      const id = validateEnvelope(event, event.type === 'session.deleted' ? 2 : 1)
      if (terminal) validateTerminal(event.data, failed)
      const state = session(id)
      if (state.deleted) return skip('ignored')
      if (event.type === 'session.created') {
        // A late create must not reset terminal dedup state or reorder delivery.
        if (state.created || state.lastSeq >= event.durable.seq) return skip('duplicate')
        const properties = structuredClone(event.data)
        state.created = true
        state.lastSeq = event.durable.seq
        counts.mapped++
        return { type: 'session.created', properties }
      }
      if (terminal && state.messages.has(event.data.assistantMessageID)) return skip('duplicate')
      if (event.durable.seq <= state.lastSeq) fail('Reordered or conflicting native terminal/session event; refusing delivery')
      if (event.type === 'session.deleted') {
        state.messages.clear()
        state.deleted = true
        state.lastSeq = event.durable.seq
        return skip('ignored')
      }
      if (state.messages.size >= maxMessagesPerSession) fail('Assistant message capacity exhausted; refusing unsafe eviction')
      // Terminal events are self-contained. No preceding start/delta is required.
      // Full native provenance is namespaced; do not fabricate a complete V1 Message.Info.
      const native = structuredClone(event)
      const info = {
        id: native.data.assistantMessageID, sessionID: id, role: 'assistant',
        time: { completed: native.created }, finish: native.data.finish ?? 'error',
        ...(failed ? { error: native.data.error } : {}),
        ...(native.data.cost !== undefined ? { cost: native.data.cost } : {}),
        ...(native.data.tokens !== undefined ? { tokens: native.data.tokens } : {}),
      }
      state.messages.add(info.id)
      state.lastSeq = event.durable.seq
      counts.mapped++
      return { type: 'message.updated', properties: { info, bridge: { native } } }
    },
    dispose() { closed = true; sessions.clear() },
    snapshot() {
      return Object.freeze({ ...counts, closed, sessions: sessions.size,
        messages: [...sessions.values()].reduce((total, state) => total + state.messages.size, 0),
        tombstones: [...sessions.values()].filter(state => state.deleted).length })
    },
  })
}
