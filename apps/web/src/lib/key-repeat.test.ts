import { afterEach, expect, it, vi } from 'vitest'
import { createKeyRepeat } from './key-repeat'

afterEach(() => vi.useRealTimers())

it('sends one character on a tap, on release', () => {
  vi.useFakeTimers()
  const press = vi.fn()
  const repeat = createKeyRepeat(press)
  repeat.start()
  vi.advanceTimersByTime(100)
  expect(press).not.toHaveBeenCalled()
  repeat.release()
  vi.advanceTimersByTime(1000)
  expect(press).toHaveBeenCalledTimes(1)
})

it('repeats characters after a short hold and sends nothing extra on release', () => {
  vi.useFakeTimers()
  const press = vi.fn()
  const repeat = createKeyRepeat(press)
  repeat.start()
  vi.advanceTimersByTime(349)
  expect(press).not.toHaveBeenCalled()
  vi.advanceTimersByTime(601)
  expect(press).toHaveBeenCalledTimes(13)
  repeat.release()
  vi.advanceTimersByTime(3000)
  expect(press).toHaveBeenCalledTimes(13)
})

it('stop cancels a pending tap and never stacks repeat timers', () => {
  vi.useFakeTimers()
  const press = vi.fn()
  const repeat = createKeyRepeat(press)
  repeat.start()
  vi.advanceTimersByTime(100)
  repeat.stop()
  vi.advanceTimersByTime(1000)
  expect(press).not.toHaveBeenCalled()
  repeat.start()
  repeat.start()
  vi.advanceTimersByTime(400)
  expect(press).toHaveBeenCalledTimes(2)
  repeat.stop()
})
