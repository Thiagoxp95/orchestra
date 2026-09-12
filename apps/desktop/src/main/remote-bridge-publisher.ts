/** One in-flight state write and one replacement, never an offline replay log. */
export function createLatestPublisher<T>(publish: (value: T) => Promise<unknown>, onError: (error: unknown) => void = () => {}) {
  let pending: { value: T } | undefined
  let running = false
  let generation = 0
  const pump = async () => {
    if (running) return
    running = true
    const gen = generation
    while (pending && gen === generation) {
      const { value } = pending
      pending = undefined
      try { await publish(value) } catch (error) { if (gen === generation) onError(error) }
    }
    if (gen === generation) running = false
  }
  return {
    push(value: T) { pending = { value }; void pump() },
    reset() { generation++; pending = undefined; running = false },
  }
}
