/**
 * Strict OpenCode 2.0.26 Promise CommandInvocation decoder.
 * Documented input: {sessionID, prompt: {text, files?}, delivery}.
 * No output transport is inferred; a separate verified delivery adapter is required.
 */
export class V2CommandInvocationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'V2CommandInvocationError'
  }
}

export function decodeV2CommandInvocation(invocation, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z][\w.-]*$/.test(name)) {
    throw new V2CommandInvocationError('Invalid registered command name')
  }
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
    throw new V2CommandInvocationError('V2 command invocation must be an object')
  }
  const { sessionID, prompt, delivery } = invocation
  if (typeof sessionID !== 'string' || !sessionID) {
    throw new V2CommandInvocationError('V2 command invocation requires sessionID')
  }
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || typeof prompt.text !== 'string') {
    throw new V2CommandInvocationError('V2 command invocation requires prompt.text')
  }
  if (prompt.files !== undefined && (!Array.isArray(prompt.files) || prompt.files.length > 0)) {
    throw new V2CommandInvocationError('Legacy command arguments cannot safely represent V2 file attachments')
  }
  if (delivery !== 'queue' && delivery !== 'steer') {
    throw new V2CommandInvocationError('V2 command invocation requires queue or steer delivery')
  }
  return { command: name, sessionID, arguments: prompt.text }
}
