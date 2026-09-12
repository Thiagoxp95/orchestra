import { expect, test } from 'vitest'
import { createLatestPublisher } from './remote-bridge-publisher'

test('a disconnected publisher retains only the latest state without queuing network writes', async () => {
  const sent: number[] = []; const complete: (() => void)[] = []
  const publisher = createLatestPublisher<number>(n => { sent.push(n); return new Promise<void>(r => complete.push(r)) })
  publisher.push(0)
  for (let i = 1; i <= 2000; i++) publisher.push(i)
  expect(sent).toEqual([0])
  complete.shift()!(); await new Promise(r => setTimeout(r, 0))
  expect(sent).toEqual([0, 2000])
  complete.shift()!()
})

test('replacing a dead client abandons its queued state and ignores its late completion', async () => {
  const sent: number[] = []; const complete: (() => void)[] = []
  const publisher = createLatestPublisher<number>(n => { sent.push(n); return new Promise<void>(r => complete.push(r)) })
  publisher.push(1); publisher.push(2); publisher.reset(); publisher.push(3); publisher.push(4)
  expect(sent).toEqual([1, 3])
  complete.shift()!(); await new Promise(r => setTimeout(r, 0))
  expect(sent).toEqual([1, 3])
  complete.shift()!(); await new Promise(r => setTimeout(r, 0))
  expect(sent).toEqual([1, 3, 4])
  publisher.reset(); complete.shift()!()
})
