import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const test = vi.hoisted(() => ({
  directory: '',
  failRename: false,
  shortWrites: false,
  failRead: false,
  writesBeforeFailure: -1
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (test.failRename) throw new Error('injected rename failure')
      return actual.renameSync(...args)
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (test.failRead) throw new Error('injected read failure')
      return actual.readSync(fd, buffer, offset, Math.min(length, 65536), position)
    },
    writeSync: (fd: number, buffer: Buffer, offset = 0, length = buffer.length, position: number | null = null) => {
      if (test.writesBeforeFailure === 0) throw new Error('injected write failure')
      if (test.writesBeforeFailure > 0) test.writesBeforeFailure--
      return actual.writeSync(fd, buffer, offset, test.shortWrites ? Math.min(length, 65536) : length, position)
    }
  }
})
vi.mock('./protocol', () => ({ get HISTORY_DIR() { return test.directory } }))
import { HistoryWriter } from './history-writer'
const LIMIT = 5 * 1024 * 1024
const writers: HistoryWriter[] = []
const file = () => join(test.directory, 'session', 'scrollback.bin')

function writer(): HistoryWriter {
  const value = new HistoryWriter('session', '/repo', 80, 24)
  value.open()
  writers.push(value)
  return value
}

beforeEach(() => {
  test.failRename = false
  test.shortWrites = false
  test.failRead = false
  test.writesBeforeFailure = -1
  test.directory = fs.mkdtempSync(join(tmpdir(), 'orchestra-history-test-'))
})

afterEach(() => {
  writers.splice(0).forEach(value => value.close())
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(test.directory, { recursive: true, force: true })
})

describe('bounded terminal history', () => {
  it('keeps a long-running session below 5MB after crossing the limit', () => {
    const value = writer()
    value.write('x'.repeat(LIMIT))
    value.write('latest output')
    expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
    expect(fs.readFileSync(file(), 'utf8').endsWith('latest output')).toBe(true)
  })
  it('does not allocate a 2.5MB tail for every subsequent terminal chunk', () => {
    const value = writer()
    value.write('x'.repeat(LIMIT))
    const chunks = Array.from({ length: 200 }, (_, index) => 'x'.repeat(((index % 16) + 1) * 1024))
    const allocations = vi.spyOn(Buffer, 'alloc')
    const started = performance.now()
    for (const chunk of chunks) value.write(chunk)
    const elapsedMs = performance.now() - started
    const tailAllocations = allocations.mock.calls.filter(([size]) => size >= LIMIT / 2).length
    console.info(`history boundary: chunks=200 chunkBytes=1024..16384 elapsedMs=${elapsedMs.toFixed(2)} tailAllocations=${tailAllocations} fileBytes=${fs.statSync(file()).size}`)
    expect(tailAllocations).toBeLessThanOrEqual(1)
    expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
  })
})

it('keeps only the newest bytes when one output chunk exceeds the entire limit', () => {
  const value = writer()
  const data = 'old'.repeat(LIMIT) + 'newest marker'
  value.write(data)
  expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
  expect(fs.readFileSync(file()).equals(Buffer.from(data).subarray(-LIMIT))).toBe(true)
  value.write('next')
  expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
  expect(fs.readFileSync(file(), 'utf8').endsWith('next')).toBe(true)
})
it('keeps the exact retained tail and appends the new output without zero padding', () => {
  const value = writer()
  const original = 'a'.repeat(LIMIT / 2) + 'b'.repeat(LIMIT / 2)
  value.write(original)
  value.write('tail')
  expect(fs.readFileSync(file()).equals(Buffer.from('b'.repeat(LIMIT / 2) + 'tail'))).toBe(true)
})
it('recovers a pre-existing oversized history at the next write', () => {
  const value = writer()
  value.close()
  fs.writeFileSync(file(), 'old'.repeat(LIMIT))
  value.open()
  value.write('latest')
  expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
  expect(fs.readFileSync(file(), 'utf8').endsWith('latest')).toBe(true)
})
it('preserves the original file and live descriptor when atomic replacement fails', () => {
  vi.useFakeTimers()
  const value = writer()
  value.write('x'.repeat(LIMIT))
  test.failRename = true
  value.write('not committed')
  expect(fs.statSync(file()).size).toBe(LIMIT)
  test.failRename = false
  vi.advanceTimersByTime(2000)
  value.write('recovered')
  expect(fs.statSync(file()).size).toBeLessThanOrEqual(LIMIT)
  expect(fs.readFileSync(file(), 'utf8').endsWith('recovered')).toBe(true)
})

it('completes partial writes and counts only bytes written across multiple trims', () => {
  test.shortWrites = true
  const value = writer()
  const chunk = 'z'.repeat(1024 * 1024)
  for (let index = 0; index < 20; index++) value.write(chunk)
  const contents = fs.readFileSync(file())
  expect(contents.length).toBeGreaterThan(LIMIT / 2)
  expect(contents.length).toBeLessThanOrEqual(LIMIT)
  expect(contents.every(byte => byte === 122)).toBe(true)
})
it('backs off failed truncation without allocating a tail on each output chunk', () => {
  vi.useFakeTimers()
  const value = writer()
  value.write('x'.repeat(LIMIT))
  test.failRename = true
  const allocations = vi.spyOn(Buffer, 'alloc')
  for (let index = 0; index < 200; index++) value.write('latest')
  expect(allocations.mock.calls.filter(([size]) => size >= LIMIT / 2).length).toBe(1)
  expect(fs.statSync(file()).size).toBe(LIMIT)
  expect(fs.readdirSync(join(test.directory, 'session')).sort()).toEqual(['meta.json', 'scrollback.bin'])
})

it.each(['read', 'write'] as const)('recovers after a failed replacement %s without changing the original history', (operation) => {
  vi.useFakeTimers()
  const value = writer()
  value.write('x'.repeat(LIMIT))
  if (operation === 'read') test.failRead = true
  else test.writesBeforeFailure = 0
  value.write('not committed')
  expect(fs.statSync(file()).size).toBe(LIMIT)
  expect(fs.readdirSync(join(test.directory, 'session')).sort()).toEqual(['meta.json', 'scrollback.bin'])
  test.failRead = false
  test.writesBeforeFailure = -1
  vi.advanceTimersByTime(2000)
  value.write('recovered')
  expect(fs.readFileSync(file()).equals(Buffer.from('x'.repeat(LIMIT / 2) + 'recovered'))).toBe(true)
})
it('reconciles a partial append after a disk error before the next boundary check', () => {
  vi.useFakeTimers()
  const value = writer()
  value.write('x'.repeat(LIMIT - 131072))
  test.shortWrites = true
  test.writesBeforeFailure = 1
  value.write('y'.repeat(131072))
  expect(fs.statSync(file()).size).toBe(LIMIT - 65536)
  test.writesBeforeFailure = -1
  vi.advanceTimersByTime(2000)
  value.write('z'.repeat(131072))
  const contents = fs.readFileSync(file())
  expect(contents.length).toBe(LIMIT / 2 + 131072)
  expect(contents.subarray(-196608).equals(Buffer.from('y'.repeat(65536) + 'z'.repeat(131072)))).toBe(true)
})
