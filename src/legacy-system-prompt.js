/**
 * Conservative V1 experimental.chat.system.transform -> V2 session.context bridge.
 *
 * V1 receives mutable output.system: string[]. V2 context supplies structured
 * system parts. We deliberately refuse non-text parts rather than silently
 * deleting/reordering media or provider-specific instructions.
 *
 * The legacy hook may perform I/O (e.g. personality mood drift). Consequently
 * this is NOT a replay-safe transform; it must only be registered on a verified
 * model-context hook, never a registry-rebuild transform.
 */
export class LegacySystemPromptError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'LegacySystemPromptError'
  }
}

export function extractSystemText(parts) {
  if (!Array.isArray(parts)) throw new LegacySystemPromptError('V2 context.system must be an array')
  if (Object.keys(parts).filter(key => /^(0|[1-9]\d*)$/.test(key)).length !== parts.length) {
    throw new LegacySystemPromptError('V2 context.system must be a dense array')
  }
  return parts.map((part, index) => {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') {
      throw new LegacySystemPromptError(`Unsupported V2 system part at index ${index}; refusing lossy translation`)
    }
    return part.text
  })
}

/** Match unchanged text across insertions/removals so host-owned metadata
 * follows its original text part rather than the old array index. For repeated
 * identical strings, alignment is necessarily ambiguous; choose a stable
 * monotonic match and never attach metadata to different text. */
export function preserveUnchangedSystemParts(originalParts, updatedTexts) {
  const before = originalParts.map(part => part.text)
  const m = before.length
  const n = updatedTexts.length
  // Quadratic LCS storage is intentionally bounded to prevent a legacy hook
  // from causing excessive memory use with unusually large prompt arrays.
  if (m * n > 1_000_000) {
    throw new LegacySystemPromptError('System prompt alignment exceeds safety limit')
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i] === updatedTexts[j]
        ? 1 + dp[i + 1][j + 1]
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result = updatedTexts.map(text => ({ type: 'text', text }))
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (before[i] === updatedTexts[j]) {
      result[j] = originalParts[i]
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return result
}

/**
 * Explicit mapping is mandatory: V2's session/model data is not assumed to
 * match the legacy hook input shape. On failure, original system is untouched.
 */
export async function applyLegacySystemPrompt(hook, v2Event, { mapInput, assertActive } = {}) {
  if (typeof hook !== 'function') throw new TypeError('Legacy system prompt hook must be a function')
  if (!v2Event || typeof v2Event !== 'object') throw new TypeError('V2 context event must be an object')
  if (typeof mapInput !== 'function') throw new LegacySystemPromptError('Legacy system hook input mapper is required')
  const originalArray = v2Event.system
  // Validate the host shape before accessing array methods or invoking any
  // mapper/legacy callback. A malformed host event is a bridge contract error.
  const original = extractSystemText(originalArray)
  const originalParts = originalArray.slice()
  const input = await mapInput(v2Event)
  if (!input || typeof input !== 'object') throw new LegacySystemPromptError('Legacy hook input mapper returned invalid input')
  const output = { system: [...original] }
  await hook(input, output)
  if (!Array.isArray(output.system) ||
      Object.keys(output.system).filter(key => /^(0|[1-9]\d*)$/.test(key)).length !== output.system.length ||
      output.system.some((part) => typeof part !== 'string')) {
    throw new LegacySystemPromptError('Legacy system hook must return an array of strings')
  }
  // Preserve host-owned metadata and object identity for unchanged text parts.
  // Rebuilding every part as {type, text} silently discarded additional
  // fields (e.g. provenance or provider metadata) even for a no-op hook.
  // An asynchronous mapper or hook may allow another host callback to edit
  // the same context. Refuse to commit a stale snapshot over those changes.
  if (v2Event.system !== originalArray ||
      originalArray.length !== originalParts.length ||
      originalParts.some((part, index) => originalArray[index] !== part || part.text !== original[index])) {
    throw new LegacySystemPromptError('V2 system context changed during legacy hook; refusing stale overwrite')
  }
  assertActive?.()
  const updated = preserveUnchangedSystemParts(originalParts, output.system)
  // Preserve event array identity, which the V2 runtime may retain.
  v2Event.system.splice(0, v2Event.system.length, ...updated)
  return v2Event.system
}

/**
 * Register the V2 model-context callback. This deliberately does not attempt
 * request-kind filtering: the context event shape inspected in the archived
 * V2 API does not include a request-kind field. The host must verify when
 * context hooks run before behavioral equivalence can be claimed.
 */
export async function registerLegacySystemPrompt(ctx, hook, options = {}) {
  if (typeof ctx?.session?.hook !== 'function') {
    throw new LegacySystemPromptError('V2 session.hook is unavailable')
  }
  if (typeof options.mapInput !== 'function') {
    throw new LegacySystemPromptError('Legacy system hook input mapper is required')
  }
  return ctx.session.hook('context', (event) => applyLegacySystemPrompt(hook, event, options))
}
