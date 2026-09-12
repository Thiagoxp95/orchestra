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
  maxPendingBytes?: number
  onError?: (error: unknown) => void
  onFlush: (data: string) => unknown
}): OutputBatcher {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt: number | null = null
  let inFlight = false
  let stopped = false
  let bufferedBytes = 0

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const fail = (error: unknown) => {
    if (stopped) return
    stopped = true
    clearTimer()
    buffer = ''; bufferedBytes = 0
    opts.onError?.(error)
  }

  const flush = () => {
    clearTimer()
    if (stopped || inFlight || buffer.length === 0) return
    const out = buffer
    buffer = ''; bufferedBytes = 0
    lastFlushAt = Date.now()
    try {
      const result = opts.onFlush(out)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        inFlight = true
        void Promise.resolve(result).then(() => {
          inFlight = false
          if (!stopped && buffer) timer = setTimeout(flush, Math.max(0, opts.flushMs - (Date.now() - lastFlushAt!)))
        }, fail)
      }
    } catch (error) { fail(error) }
  }

  return {
    push(data: string) {
      if (stopped || !data) return
      bufferedBytes += Buffer.byteLength(data)
      if (bufferedBytes > (opts.maxPendingBytes ?? 512 * 1024)) {
        fail(new Error('Terminal delivery backlog exceeded recovery limit'))
        return
      }
      buffer += data
      if (inFlight) return
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
      stopped = true
      clearTimer()
      buffer = ''; bufferedBytes = 0
    },
  }
}
