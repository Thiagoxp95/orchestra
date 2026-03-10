import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findCodexRolloutByDirectory, listCodexRolloutPaths } from './codex-rollout-files'

const tempDirs: string[] = []

interface RolloutOptions {
  cwd: string
  threadId: string
  sessionStartedAtMs?: number
  mtimeMs: number
  extraPayload?: Record<string, unknown>
}

function makeTempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollouts-'))
  tempDirs.push(dir)
  return dir
}

function writeRollout(
  rootDir: string,
  relativePath: string,
  options: RolloutOptions,
): string {
  const { cwd, threadId, sessionStartedAtMs = options.mtimeMs, mtimeMs, extraPayload } = options
  const filePath = path.join(rootDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      type: 'session_meta',
      timestamp: new Date(sessionStartedAtMs).toISOString(),
      payload: {
        id: threadId,
        cwd,
        timestamp: new Date(sessionStartedAtMs).toISOString(),
        ...extraPayload,
      },
    })}\n`,
  )

  const time = new Date(mtimeMs)
  fs.utimesSync(filePath, time, time)
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('listCodexRolloutPaths', () => {
  it('finds rollout files in nested date folders', () => {
    const rootDir = makeTempSessionsDir()
    const nestedPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-a.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-a',
        mtimeMs: 20_000,
      },
    )

    expect(listCodexRolloutPaths(rootDir)).toEqual([nestedPath])
  })
})

describe('findCodexRolloutByDirectory', () => {
  it('returns the rollout whose session start is closest to the watched process', () => {
    const rootDir = makeTempSessionsDir()
    const olderPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-old.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-old',
        mtimeMs: 12_000,
      },
    )
    const newerPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-new.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-new',
        mtimeMs: 15_000,
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 12_200)).toEqual({
      path: olderPath,
      threadId: 'thread-old',
    })
    expect(findCodexRolloutByDirectory(rootDir, '/repo', 14_800)).toEqual({
      path: newerPath,
      threadId: 'thread-new',
    })
    expect(olderPath).not.toBe(newerPath)
  })

  it('prefers the rollout session timestamp over a later file mtime', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-first.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-first',
        sessionStartedAtMs: 12_000,
        mtimeMs: 40_000,
      },
    )
    const secondPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-second.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-second',
        sessionStartedAtMs: 15_000,
        mtimeMs: 15_500,
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 15_100)).toEqual({
      path: secondPath,
      threadId: 'thread-second',
    })
  })

  it('reads large session_meta lines without truncating the match data', () => {
    const rootDir = makeTempSessionsDir()
    const rolloutPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-large.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-large',
        sessionStartedAtMs: 10_000,
        mtimeMs: 10_500,
        extraPayload: {
          base_instructions: {
            text: 'x'.repeat(20_000),
          },
        },
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 10_100)).toEqual({
      path: rolloutPath,
      threadId: 'thread-large',
    })
  })

  it('ignores rollout files that are too old for the watched process', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-old.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-old',
        sessionStartedAtMs: 10_000,
        mtimeMs: 25_000,
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 20_000)).toBeNull()
  })
})
