import { describe, expect, it } from 'vitest'
import { ChatInputController, guardedChatInput } from './chat-input-controller'
import { submitChatMessage } from './remote-bridge-chat-send'
import { runKeySteps } from './remote-bridge-key-steps'
import { deliverAfterResume } from './remote-bridge-resume-send'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('ChatInputController', () => {
  it('serializes mutations to one session while other sessions remain independent', async () => {
    const input = new ChatInputController()
    const gate = deferred()
    const events: string[] = []
    const first = input.run('a', async () => { events.push('first'); await gate.promise })
    const second = input.run('a', async () => { events.push('second') })
    await input.run('b', async () => { events.push('other') })
    expect(events).toEqual(['first', 'other'])
    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first', 'other', 'second'])
  })

  it('Stop invalidates both the delayed Enter and operations already waiting behind it', async () => {
    const input = new ChatInputController()
    const gate = deferred()
    const writes: string[] = []
    const started = deferred()
    const first = input.run('a', async (check) => {
      writes.push('paste')
      started.resolve()
      await gate.promise
      check()
      writes.push('enter')
    }).catch((error: Error) => error.message)
    const queued = input.run('a', async () => { writes.push('model') }).catch((error: Error) => error.message)
    await started.promise
    input.cancel('a')
    writes.push('escape')
    gate.resolve()
    expect(await first).toMatch(/cancel/i)
    expect(await queued).toMatch(/cancel/i)
    await input.run('a', async () => { writes.push('next message') })
    expect(writes).toEqual(['paste', 'escape', 'next message'])
  })

  it('a rejected operation does not poison later sends', async () => {
    const input = new ChatInputController()
    await expect(input.run('a', async () => { throw new Error('disconnected') })).rejects.toThrow('disconnected')
    await expect(input.run('a', async () => 'accepted')).resolves.toBe('accepted')
  })

  it('Stop releases the queue even when a download or transport wait never settles', async () => {
    const input = new ChatInputController()
    const started = deferred()
    const sending = input.run('a', async () => {
      started.resolve()
      await new Promise<void>(() => {})
    })
    const cancelled = expect(sending).rejects.toThrow('Chat input cancelled')
    await started.promise
    input.cancel('a')
    await cancelled
    await expect(input.run('a', async () => 'next message')).resolves.toBe('next message')
  }, 1000)

  it('Stop does not cancel another conversation', async () => {
    const input = new ChatInputController()
    const gate = deferred()
    const other = input.run('b', async (check) => { await gate.promise; check(); return 'accepted' })
    input.cancel('a')
    gate.resolve()
    await expect(other).resolves.toBe('accepted')
  })

  it('cancels the real submit protocol after paste, before Enter', async () => {
    const input = new ChatInputController()
    const pasted = deferred()
    const settle = deferred()
    const writes: string[] = []
    let hasPaste = false
    const sending = input.run('a', (check) => submitChatMessage(guardedChatInput({
      write(data: string) {
        writes.push(data)
        if (data.includes('[200~')) { hasPaste = true; pasted.resolve() }
      },
      isQuiet: () => true,
      sleep: () => hasPaste ? settle.promise : Promise.resolve(),
    }, check), 'hello')).catch((error: Error) => error.message)
    await pasted.promise
    input.cancel('a')
    settle.resolve()
    expect(await sending).toMatch(/cancel/i)
    expect(writes.some((data) => data.includes('hello'))).toBe(true)
    expect(writes).not.toContain('\r')
  })

  it('cancels an entire question-route-and-send transaction', async () => {
    const input = new ChatInputController()
    const routed = deferred()
    const wait = deferred()
    const writes: string[] = []
    const sending = input.run('a', async (check) => {
      const deps = guardedChatInput({
        write(data: string) { writes.push(data); routed.resolve() },
        sleep: () => wait.promise,
        isQuiet: () => true,
      }, check)
      await runKeySteps(deps, [{ data: 'chat about this', delayAfterMs: 100 }])
      await submitChatMessage(deps, 'hello')
    }).catch((error: Error) => error.message)
    await routed.promise
    input.cancel('a')
    wait.resolve()
    expect(await sending).toMatch(/cancel/i)
    expect(writes).toEqual(['chat about this'])
  })

  it('cancels a resume waiting for boot before it can submit a message', async () => {
    const input = new ChatInputController()
    const polling = deferred()
    const wait = deferred()
    const writes: string[] = []
    let ready = false
    const sending = input.run('a', (check) => deliverAfterResume(guardedChatInput({
      write: (data: string) => { writes.push(data) },
      sleep: async () => { polling.resolve(); await wait.promise },
      isQuiet: () => true,
      sawOutput: () => ready,
      readPrompt: () => null,
      runKeys: async () => {},
      isAlive: async () => true,
    }, check), 'hello')).catch((error: Error) => error.message)
    await polling.promise
    input.cancel('a')
    ready = true
    wait.resolve()
    expect(await sending).toMatch(/cancel/i)
    expect(writes).toEqual([])
  })
})
