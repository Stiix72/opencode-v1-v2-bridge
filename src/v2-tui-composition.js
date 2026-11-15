/** Compose TUI subscriptions with transactional setup and awaited teardown.
 * The exact v2.0.27 TUI Plugin.Definition accepts async setup and cleanup.
 */
export function composeTuiCompanions(...companions) {
  if (!companions.length || companions.some(item => typeof item?.setup !== 'function')) {
    throw new TypeError('TUI companions must provide setup')
  }
  return async context => {
    const cleanups = []
    try {
      for (const companion of companions) {
        const cleanup = await companion.setup(context)
        if (cleanup !== undefined && typeof cleanup !== 'function') {
          throw new TypeError('TUI companion setup must return cleanup or void')
        }
        if (cleanup) cleanups.push(cleanup)
      }
    } catch (error) {
      const results = await Promise.allSettled(cleanups.reverse().map(cleanup => Promise.resolve().then(cleanup)))
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError([error, ...failures], 'TUI setup and rollback failed')
      throw error
    }
    let closing
    return () => {
      if (!closing) closing = (async () => {
        const results = await Promise.allSettled(cleanups.reverse().map(cleanup => Promise.resolve().then(cleanup)))
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
        if (failures.length) throw new AggregateError(failures, 'TUI cleanup failed')
      })()
      return closing
    }
  }
}
