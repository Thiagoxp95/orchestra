/** Batch IPC bursts into one render per frame, with at most one xterm parse in flight. */
export function createTerminalWriteQueue(
  write: (text: string, done: () => void) => void,
  schedule: (callback: () => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let chunks: string[] = []
  let frame: number | null = null
  let writing = false
  let disposed = false
  const flushWaiters: Array<() => void> = []
  const resolveFlush = () => {
    if (!writing && chunks.length === 0) flushWaiters.splice(0).forEach(resolve => resolve())
  }
  const request = () => {
    if (disposed || writing || frame !== null || !chunks.length) return
    frame = schedule(() => {
      frame = null
      if (disposed) return
      let text = ''
      while (chunks.length && text.length < 65536) {
        const room = 65536 - text.length
        const chunk = chunks.shift()!
        text += chunk.slice(0, room)
        if (chunk.length > room) chunks.unshift(chunk.slice(room))
      }
      writing = true
      write(text, () => { writing = false; request(); resolveFlush() })
    })
  }
  return {
    write(text: string) { if (!disposed && text) { chunks.push(text); request() } },
    flush(): Promise<void> {
      if (disposed || (!writing && chunks.length === 0)) return Promise.resolve()
      return new Promise(resolve => { flushWaiters.push(resolve) })
    },
    dispose() { disposed = true; chunks = []; if (frame !== null) cancel(frame); frame = null; flushWaiters.splice(0).forEach(resolve => resolve()) },
  }
}
