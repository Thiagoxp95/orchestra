import { afterEach, expect, it, vi } from 'vitest'
import { createKeyRepeat } from './key-repeat'

afterEach(() => vi.useRealTimers())

it('deletes immediately, then repeats characters after a short hold', () => {
  vi.useFakeTimers()
  const press = vi.fn()
  const repeat = createKeyRepeat(press)
  repeat.start()
  expect(press).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(349)
  expect(press).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(601)
  expect(press).toHaveBeenCalledTimes(14)
  repeat.stop()
  vi.advanceTimersByTime(3000)
  expect(press).toHaveBeenCalledTimes(14)
})

it('cancels a short hold and never stacks repeat timers on another press', () => {
  vi.useFakeTimers()
  const press = vi.fn()
  const repeat = createKeyRepeat(press)
  repeat.start()
  vi.advanceTimersByTime(100)
  repeat.stop()
  vi.advanceTimersByTime(1000)
  expect(press).toHaveBeenCalledTimes(1)
  repeat.start()
  repeat.start()
  vi.advanceTimersByTime(400)
  expect(press).toHaveBeenCalledTimes(5)
  repeat.stop()
})
