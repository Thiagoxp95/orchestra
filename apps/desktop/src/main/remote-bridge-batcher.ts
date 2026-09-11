export interface OutputBatcher {
  push(data: string): void
  flush(): void
  dispose(): void
}

export function createOutputBatcher(opts: {
  flushMs: number
  maxBytes: number
  /** Send the first output after an idle interval without a batching delay. */
  leading?: boolean
  onFlush: (data: string) => void
}): OutputBatcher {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt: number | null = null

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = () => {
    clearTimer()
    if (buffer.length === 0) return
    const out = buffer
    buffer = ''
    lastFlushAt = Date.now()
    opts.onFlush(out)
  }

  return {
    push(data: string) {
      if (!data) return
      buffer += data
      const wait = opts.leading && lastFlushAt !== null
        ? Math.max(0, opts.flushMs - (Date.now() - lastFlushAt))
        : opts.flushMs
      if (buffer.length >= opts.maxBytes || (opts.leading && (lastFlushAt === null || wait === 0))) {
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, wait)
    },
    flush,
    dispose() {
      clearTimer()
      buffer = ''
    },
  }
}
