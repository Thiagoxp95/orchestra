export interface OutputBatcher {
  push(data: string): void
  flush(): void
  dispose(): void
}

export function createOutputBatcher(opts: {
  flushMs: number
  maxBytes: number
  onFlush: (data: string) => void
}): OutputBatcher {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

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
    opts.onFlush(out)
  }

  return {
    push(data: string) {
      buffer += data
      if (buffer.length >= opts.maxBytes) {
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, opts.flushMs)
    },
    flush,
    dispose() {
      clearTimer()
      buffer = ''
    },
  }
}
