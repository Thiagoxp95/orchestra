export type NativeChatReceipt = { status: 'accepted' | 'failed'; error?: string } | null

export type NativeChatReceiptWatch = {
  localQueryResult: () => NativeChatReceipt | undefined
  onUpdate: (listener: () => void) => () => void
}

/**
 * Follow a command until the host gives a definite answer. Timeout is only a
 * warning: retrying while the original command is still queued can duplicate a
 * prompt, so the promise and subscription deliberately remain pending.
 */
export function waitForNativeChatReceipt(
  watch: NativeChatReceiptWatch,
  options: { timeoutMs: number; onTimeout: () => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stopRequested = false
    let unsubscribe: (() => void) | null = null
    const timer = setTimeout(() => {
      if (!settled) options.onTimeout()
    }, options.timeoutMs)

    const stop = () => {
      if (!unsubscribe) {
        stopRequested = true
        return
      }
      const dispose = unsubscribe
      unsubscribe = null
      dispose()
    }
    const finish = (cause?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      if (cause) reject(cause)
      else resolve()
    }
    const read = () => {
      let receipt: NativeChatReceipt | undefined
      try {
        receipt = watch.localQueryResult()
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error('Could not read command receipt'))
        return
      }
      if (receipt?.status === 'accepted') finish()
      else if (receipt?.status === 'failed') {
        finish(new Error(receipt.error || 'Desktop rejected the native chat command'))
      }
    }

    try {
      unsubscribe = watch.onUpdate(read)
      if (stopRequested) stop()
      read()
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error('Could not follow command receipt'))
    }
  })
}
