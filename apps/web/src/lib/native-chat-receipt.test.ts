import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForNativeChatReceipt, type NativeChatReceipt } from './native-chat-receipt'

function receiptWatch(initial: NativeChatReceipt | undefined) {
  let value = initial
  let listener: (() => void) | undefined
  const unsubscribe = vi.fn()
  return {
    watch: {
      localQueryResult: () => value,
      onUpdate: (next: () => void) => {
        listener = next
        return unsubscribe
      },
    },
    publish(next: NativeChatReceipt) {
      value = next
      listener?.()
    },
    unsubscribe,
  }
}

describe('waitForNativeChatReceipt', () => {
  afterEach(() => vi.useRealTimers())

  it('reports timeout uncertainty without settling or unsubscribing', async () => {
    vi.useFakeTimers()
    const source = receiptWatch(null)
    const onTimeout = vi.fn()
    let settled = false
    const pending = waitForNativeChatReceipt(source.watch, {
      timeoutMs: 60_000,
      onTimeout,
    }).finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    expect(source.unsubscribe).not.toHaveBeenCalled()

    source.publish({ status: 'accepted' })
    await pending
    expect(settled).toBe(true)
    expect(source.unsubscribe).toHaveBeenCalledOnce()
  })

  it('unsubscribes when an accepted receipt arrives during subscription setup', async () => {
    const unsubscribe = vi.fn()
    const watch = {
      localQueryResult: () => ({ status: 'accepted' }) as const,
      onUpdate: (listener: () => void) => {
        listener()
        return unsubscribe
      },
    }

    await waitForNativeChatReceipt(watch, { timeoutMs: 60_000, onTimeout: vi.fn() })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects and unsubscribes when the host marks the command failed', async () => {
    const source = receiptWatch(null)
    const pending = waitForNativeChatReceipt(source.watch, {
      timeoutMs: 60_000,
      onTimeout: vi.fn(),
    })

    source.publish({ status: 'failed', error: 'Interrupted' })
    await expect(pending).rejects.toThrow('Interrupted')
    expect(source.unsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects and unsubscribes on a real receipt query error', async () => {
    const unsubscribe = vi.fn()
    const watch = {
      localQueryResult: () => {
        throw new Error('Not authorized')
      },
      onUpdate: () => unsubscribe,
    }

    await expect(
      waitForNativeChatReceipt(watch, { timeoutMs: 60_000, onTimeout: vi.fn() }),
    ).rejects.toThrow('Not authorized')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
