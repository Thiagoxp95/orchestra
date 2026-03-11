import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doesCodexRolloutMatchPromptHints, findCodexRolloutByDirectory, listCodexRolloutPaths } from './codex-rollout-files'

const tempDirs: string[] = []

interface RolloutOptions {
  cwd: string
  threadId: string
  sessionStartedAtMs?: number
  mtimeMs: number
  extraPayload?: Record<string, unknown>
  lines?: Record<string, unknown>[]
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
  const { cwd, threadId, sessionStartedAtMs = options.mtimeMs, mtimeMs, extraPayload, lines = [] } = options
  const filePath = path.join(rootDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(sessionStartedAtMs).toISOString(),
        payload: {
          id: threadId,
          cwd,
          timestamp: new Date(sessionStartedAtMs).toISOString(),
          ...extraPayload,
        },
      }),
      ...lines.map((line) => JSON.stringify(line)),
      '',
    ].join('\n'),
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
  it('returns the prompt-matched rollout whose session start is closest to the watched process', () => {
    const rootDir = makeTempSessionsDir()
    const olderPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-old.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-old',
        mtimeMs: 12_000,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'older prompt',
            },
          },
        ],
      },
    )
    const newerPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-new.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-new',
        mtimeMs: 15_000,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'newer prompt',
            },
          },
        ],
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 12_200, {
      promptHints: ['older prompt'],
    })).toEqual({
      path: olderPath,
      threadId: 'thread-old',
    })
    expect(findCodexRolloutByDirectory(rootDir, '/repo', 14_800, {
      promptHints: ['newer prompt'],
    })).toEqual({
      path: newerPath,
      threadId: 'thread-new',
    })
    expect(olderPath).not.toBe(newerPath)
  })

  it('prefers the rollout session timestamp over a later file mtime for the prompt-matched candidate', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-first.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-first',
        sessionStartedAtMs: 12_000,
        mtimeMs: 40_000,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'first prompt',
            },
          },
        ],
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
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'second prompt',
            },
          },
        ],
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 15_100, {
      promptHints: ['second prompt'],
    })).toEqual({
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

  it('returns null when multiple same-cwd rollouts are plausible and there are no prompt hints', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-a.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-a',
        sessionStartedAtMs: 10_000,
        mtimeMs: 10_500,
      },
    )
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-b.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-b',
        sessionStartedAtMs: 10_200,
        mtimeMs: 10_700,
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 10_100)).toBeNull()
  })

  it('uses prompt hints to select the owned rollout when multiple same-cwd candidates exist', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-release.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-release',
        sessionStartedAtMs: 10_000,
        mtimeMs: 10_500,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'summarize recent commits',
            },
          },
        ],
      },
    )
    const devPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-dev.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-dev',
        sessionStartedAtMs: 10_200,
        mtimeMs: 10_700,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'ask me something',
            },
          },
        ],
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 10_100, {
      promptHints: ['ask me something'],
    })).toEqual({
      path: devPath,
      threadId: 'thread-dev',
    })
  })

  it('returns null when the only same-cwd rollout does not match the local prompt history', () => {
    const rootDir = makeTempSessionsDir()
    writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-other.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-other',
        sessionStartedAtMs: 10_000,
        mtimeMs: 10_500,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'yes. that is the bug path i fixed.',
            },
          },
        ],
      },
    )

    expect(findCodexRolloutByDirectory(rootDir, '/repo', 10_100, {
      promptHints: ['ask me something'],
    })).toBeNull()
  })
})

describe('doesCodexRolloutMatchPromptHints', () => {
  it('matches user prompts from either event messages or response items', () => {
    const rootDir = makeTempSessionsDir()
    const rolloutPath = writeRollout(
      rootDir,
      path.join('2026', '03', '09', 'rollout-prompts.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-prompts',
        sessionStartedAtMs: 10_000,
        mtimeMs: 10_500,
        lines: [
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Explain code snippet',
                },
              ],
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'What do you need',
            },
          },
        ],
      },
    )

    expect(doesCodexRolloutMatchPromptHints(rolloutPath, [' explain   code snippet '])).toBe(true)
    expect(doesCodexRolloutMatchPromptHints(rolloutPath, ['what do you need'])).toBe(true)
    expect(doesCodexRolloutMatchPromptHints(rolloutPath, ['different prompt'])).toBe(false)
  })
})
