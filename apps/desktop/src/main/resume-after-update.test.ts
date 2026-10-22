import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { agentSessionsToResume, recordSessionsForResume, takeSessionsForResume } from './resume-after-update'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'resume-after-update-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('resume after update', () => {
  it('records only agent panes whose conversation is known', () => {
    expect(
      agentSessionsToResume({
        a: { processStatus: 'claude', resumeSessionId: 'c1' },
        b: { processStatus: 'codex', resumeSessionId: 'c2' },
        c: { processStatus: 'terminal', resumeSessionId: 'c3' },
        d: { processStatus: 'claude' },
      }),
    ).toEqual(['a', 'b'])
  })

  it('returns the recorded panes that have no live PTY, once', () => {
    recordSessionsForResume(['a', 'b', 'c'], home, 1_000)
    expect(takeSessionsForResume(new Set(['b']), home, 2_000)).toEqual(['a', 'c'])
    // Consumed: a later launch resumes nothing.
    expect(takeSessionsForResume(new Set(), home, 3_000)).toEqual([])
  })

  it('ignores a marker left long before this launch', () => {
    recordSessionsForResume(['a'], home, 0)
    expect(takeSessionsForResume(new Set(), home, 60 * 60_000)).toEqual([])
  })

  it('resumes nothing without a marker', () => {
    expect(takeSessionsForResume(new Set(), home)).toEqual([])
  })
})
