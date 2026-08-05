import { describe, expect, it } from 'vitest'
import type { DisplayItem } from './chat-messages'
import {
  deriveTimeline,
  formatDuration,
  formatElapsed,
  outputLooksLikeFailure,
  type TimelineRow,
} from './chat-timeline'

const NONE = { working: false, expandedTurns: new Set<string>(), expandedGroups: new Set<string>() }

function user(uid: string, text: string, ts?: number): DisplayItem {
  return { uid, role: 'user', ts, blocks: [{ kind: 'text', text }] }
}
function assistantText(uid: string, text: string, ts?: number): DisplayItem {
  return { uid, role: 'assistant', ts, blocks: [{ kind: 'text', text }] }
}
function kinds(rows: TimelineRow[]): string[] {
  return rows.map((r) => r.kind)
}

describe('deriveTimeline', () => {
  it('renders a settled turn folded: user, fold header, terminal prose only', () => {
    const items: DisplayItem[] = [
      user('u1', 'do the thing', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'thinking', text: 'hmm' },
          { kind: 'tool', id: 't1', name: 'Bash', input: 'ls', result: { output: 'ok' } },
        ],
      },
      assistantText('a2', 'done!', 9000),
    ]
    const rows = deriveTimeline(items, NONE)
    expect(kinds(rows)).toEqual(['user', 'turn-fold', 'assistant'])
    const fold = rows[1] as Extract<TimelineRow, { kind: 'turn-fold' }>
    expect(fold.label).toBe('Worked for 8.0s')
    expect(fold.expanded).toBe(false)
    const prose = rows[2] as Extract<TimelineRow, { kind: 'assistant' }>
    expect(prose.terminal).toBe(true)
  })

  it('expands a fold when its turn id is in expandedTurns (work fully visible, no nested toggle)', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'tool', id: 't1', name: 'Read', input: 'a.ts', result: { output: 'x' } },
          { kind: 'tool', id: 't2', name: 'Read', input: 'b.ts', result: { output: 'y' } },
          { kind: 'tool', id: 't3', name: 'Read', input: 'c.ts', result: { output: 'z' } },
        ],
      },
      assistantText('a2', 'done', 3000),
    ]
    const rows = deriveTimeline(items, { ...NONE, expandedTurns: new Set(['u1']) })
    expect(kinds(rows)).toEqual(['user', 'turn-fold', 'work', 'work', 'work', 'assistant'])
  })

  it('keeps the running turn unfolded and collapses earlier work behind a toggle', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'tool', id: 't1', name: 'Read', input: 'a.ts', result: { output: 'x' } },
          { kind: 'tool', id: 't2', name: 'Read', input: 'b.ts', result: { output: 'y' } },
          { kind: 'tool', id: 't3', name: 'Bash', input: 'npm test' },
        ],
      },
    ]
    const rows = deriveTimeline(items, { ...NONE, working: true })
    expect(kinds(rows)).toEqual(['user', 'work', 'work-toggle', 'working'])
    const work = rows[1] as Extract<TimelineRow, { kind: 'work' }>
    expect(work.entry.name).toBe('Bash')
    expect(work.entry.status).toBe('running')
    const toggle = rows[2] as Extract<TimelineRow, { kind: 'work-toggle' }>
    expect(toggle.hiddenCount).toBe(2)
    const working = rows[3] as Extract<TimelineRow, { kind: 'working' }>
    expect(working.sinceTs).toBe(1000)
  })

  it('expands a work group via expandedGroups, oldest entries above, toggle kept below', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'tool', id: 't1', name: 'Read', input: 'a.ts', result: { output: 'x' } },
          { kind: 'tool', id: 't2', name: 'Bash', input: 'ls' },
        ],
      },
    ]
    const rows = deriveTimeline(items, {
      ...NONE,
      working: true,
      expandedGroups: new Set(['work-group:a1:0']),
    })
    expect(kinds(rows)).toEqual(['user', 'work', 'work', 'work-toggle', 'working'])
    expect((rows[1] as Extract<TimelineRow, { kind: 'work' }>).entry.name).toBe('Read')
  })

  it('does not fold an interrupted latest turn and labels the eventual fold', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [{ kind: 'tool', id: 't1', name: 'Bash', input: 'sleep 99', result: { output: '' } }],
      },
      { uid: 's1', role: 'system', ts: 5000, blocks: [{ kind: 'text', text: 'Interrupted' }] },
    ]
    const live = deriveTimeline(items, NONE)
    expect(kinds(live)).toEqual(['user', 'work', 'system'])

    // Once a new turn starts, the interrupted turn folds with the stop label.
    const later = [...items, user('u2', 'try again', 6000), assistantText('a2', 'ok', 7000)]
    const rows = deriveTimeline(later, NONE)
    const fold = rows.find((r) => r.kind === 'turn-fold' && r.turnId === 'u1') as
      | Extract<TimelineRow, { kind: 'turn-fold' }>
      | undefined
    expect(fold?.label).toBe('You stopped after 4.0s')
  })

  it('marks pending echoes and keeps a live question out of folds', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'tool', id: 'x', name: 'Bash', input: 'ls', result: { output: 'ok' } },
          {
            kind: 'question',
            id: 'q1',
            questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
          },
        ],
      },
      user('local:1', 'queued send'),
    ]
    const rows = deriveTimeline(items, NONE)
    const q = rows.find((r) => r.kind === 'question') as Extract<TimelineRow, { kind: 'question' }>
    // an echo after the form makes it static
    expect(q.live).toBe(false)
    const echo = rows.find((r) => r.kind === 'user' && r.id === 'local:1') as Extract<
      TimelineRow,
      { kind: 'user' }
    >
    expect(echo.pending).toBe(true)

    const liveRows = deriveTimeline(items.slice(0, 2), NONE)
    const liveQ = liveRows.find((r) => r.kind === 'question') as Extract<TimelineRow, { kind: 'question' }>
    expect(liveQ.live).toBe(true)
    // the turn holding a live question must not fold even though it's settled
    expect(liveRows.some((r) => r.kind === 'turn-fold')).toBe(false)
  })

  it('inserts a day divider across >6h gaps', () => {
    const sixHours = 6 * 60 * 60 * 1000
    const items: DisplayItem[] = [
      user('u1', 'a', 1000),
      assistantText('a1', 'b', 2000),
      user('u2', 'c', 2000 + sixHours + 1),
    ]
    const rows = deriveTimeline(items, NONE)
    expect(rows.some((r) => r.kind === 'day')).toBe(true)
  })

  it('splits mixed assistant blocks into prose and work rows, prose terminal last', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [
          { kind: 'text', text: 'Let me look.' },
          { kind: 'tool', id: 't1', name: 'Read', input: 'a.ts', result: { output: 'x' } },
          { kind: 'text', text: 'All done.' },
        ],
      },
    ]
    const rows = deriveTimeline(items, { ...NONE, expandedTurns: new Set(['u1']) })
    expect(kinds(rows)).toEqual(['user', 'turn-fold', 'assistant', 'work', 'assistant'])
    const [first, last] = rows.filter((r) => r.kind === 'assistant') as Extract<
      TimelineRow,
      { kind: 'assistant' }
    >[]
    expect(first.terminal).toBe(false)
    expect(last.terminal).toBe(true)
  })

  it('surfaces orphan tool results as their own failed/success rows', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'r1',
        role: 'tool',
        ts: 2000,
        blocks: [{ kind: 'toolResult', forId: 'gone', output: 'ENOENT: no such file' }],
      },
      assistantText('a1', 'hm', 3000),
    ]
    const rows = deriveTimeline(items, { ...NONE, expandedTurns: new Set(['u1']) })
    const work = rows.find((r) => r.kind === 'work') as Extract<TimelineRow, { kind: 'work' }>
    expect(work.entry.status).toBe('failed')
  })
})

describe('review regressions', () => {
  it('working sinceTs uses the NEWEST user item even when it lacks ts', () => {
    const items: DisplayItem[] = [
      user('u1', 'old', 1000),
      assistantText('a1', 'ok', 2000),
      { uid: 'local:1', role: 'user', blocks: [{ kind: 'text', text: 'just sent' }] },
    ]
    const rows = deriveTimeline(items, { ...NONE, working: true })
    const working = rows[rows.length - 1] as Extract<TimelineRow, { kind: 'working' }>
    expect(working.sinceTs).toBeNull()
  })

  it('an unknown-role system item neither fabricates "Interrupted" nor marks the turn stopped', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      { uid: 'x1', role: 'system', ts: 2000, blocks: [{ kind: 'image' }] },
      assistantText('a1', 'done', 3000),
    ]
    const rows = deriveTimeline(items, NONE)
    const system = rows.find((r) => r.kind === 'system') as
      | Extract<TimelineRow, { kind: 'system' }>
      | undefined
    expect(system?.text ?? '').not.toBe('Interrupted')
    const fold = rows.find((r) => r.kind === 'turn-fold') as Extract<TimelineRow, { kind: 'turn-fold' }>
    expect(fold.label.startsWith('Worked')).toBe(true)
  })

  it('orphan toolResult entries keep a first-line preview', () => {
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'r1',
        role: 'tool',
        ts: 2000,
        blocks: [{ kind: 'toolResult', forId: 'gone', output: '\nENOENT: no such file\nmore' }],
      },
    ]
    const rows = deriveTimeline(items, { ...NONE, working: true })
    const work = rows.find((r) => r.kind === 'work') as Extract<TimelineRow, { kind: 'work' }>
    expect(work.entry.input).toBe('ENOENT: no such file')
  })

  it('day divider lands above a fold header, never inside the turn', () => {
    const sevenHours = 7 * 60 * 60 * 1000
    const items: DisplayItem[] = [
      user('u1', 'go', 1000),
      {
        uid: 'a1',
        role: 'assistant',
        ts: 2000,
        blocks: [{ kind: 'tool', id: 't1', name: 'Bash', input: 'sleep', result: { output: 'ok' } }],
      },
      assistantText('a2', 'done after a long time', 2000 + sevenHours),
    ]
    const rows = deriveTimeline(items, NONE)
    const dayIdx = rows.findIndex((r) => r.kind === 'day')
    const foldIdx = rows.findIndex((r) => r.kind === 'turn-fold')
    expect(dayIdx).toBeGreaterThan(-1)
    expect(dayIdx).toBeLessThan(foldIdx)
  })
})

describe('outputLooksLikeFailure', () => {
  it('flags common failure shapes', () => {
    expect(outputLooksLikeFailure('bash: foo: command not found')).toBe(true)
    expect(outputLooksLikeFailure('ENOENT: no such file or directory')).toBe(true)
    expect(outputLooksLikeFailure('Traceback (most recent call last):\n  ...')).toBe(true)
    expect(outputLooksLikeFailure('fatal: not a git repository')).toBe(true)
    expect(outputLooksLikeFailure('Process exited with exit code 2')).toBe(true)
  })
  it('passes normal output, including deep-tail mentions', () => {
    expect(outputLooksLikeFailure('all tests passed')).toBe(false)
    expect(outputLooksLikeFailure(`${'x'.repeat(3000)}\ncommand not found`)).toBe(false)
  })
})

describe('durations', () => {
  it('formatDuration', () => {
    expect(formatDuration(750)).toBe('750ms')
    expect(formatDuration(3400)).toBe('3.4s')
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(192_000)).toBe('3m 12s')
    expect(formatDuration(3_600_000)).toBe('1h')
  })
  it('formatElapsed', () => {
    expect(formatElapsed(34_000)).toBe('34s')
    expect(formatElapsed(124_000)).toBe('2m 4s')
    expect(formatElapsed(4_320_000)).toBe('1h 12m')
  })
})
