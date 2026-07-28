import { describe, expect, it } from 'vitest'
import {
  buildQuestionKeySequence,
  chatAboutKey,
  foldForDisplay,
  makeEcho,
  mergeMessages,
  pruneEchoes,
  splitFences,
  type ChatBlock,
  type SeqChatMessage,
} from './chat-messages'

const text = (t: string): ChatBlock => ({ kind: 'text', text: t })
const msg = (
  uid: string,
  seq: number,
  role: SeqChatMessage['role'],
  blocks: ChatBlock[],
  ts?: number,
): SeqChatMessage => ({ uid, seq, role, blocks, ts })

describe('mergeMessages', () => {
  it('sorts the union by seq', () => {
    const prev = [msg('b', 2, 'assistant', [text('two')])]
    const next = mergeMessages(prev, [
      msg('c', 3, 'user', [text('three')]),
      msg('a', 1, 'user', [text('one')]),
    ])
    expect(next.map((m) => m.uid)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes by uid with the later copy winning', () => {
    // A resume replay re-pushes the same uid with amended blocks; the backend
    // patches in place, so the incoming copy is the fresher one.
    const prev = [msg('a', 1, 'assistant', [text('draft')])]
    const next = mergeMessages(prev, [msg('a', 1, 'assistant', [text('final')])])
    expect(next).toHaveLength(1)
    expect(next[0].blocks).toEqual([text('final')])
  })

  it('returns prev untouched when the batch is empty', () => {
    const prev = [msg('a', 1, 'user', [text('hi')])]
    expect(mergeMessages(prev, [])).toBe(prev)
  })

  it('prepends an earlier backfill page in front of the live tail', () => {
    const prev = [msg('c', 10, 'assistant', [text('now')])]
    const next = mergeMessages(prev, [
      msg('a', 3, 'user', [text('old')]),
      msg('b', 4, 'assistant', [text('older reply')]),
    ])
    expect(next.map((m) => m.seq)).toEqual([3, 4, 10])
  })
})

describe('foldForDisplay', () => {
  const call = (id: string, name = 'Bash'): ChatBlock => ({ kind: 'tool', id, name, input: 'ls' })
  const result = (forId: string, output = 'ok'): ChatBlock => ({ kind: 'toolResult', forId, output })

  it('attaches a result to the matching tool block and drops the tool message', () => {
    const items = foldForDisplay([
      msg('a1', 1, 'assistant', [text('running'), call('t1')]),
      msg('r1', 2, 'tool', [result('t1', 'listing')]),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].blocks[1]).toEqual({
      kind: 'tool',
      id: 't1',
      name: 'Bash',
      input: 'ls',
      result: { output: 'listing', isError: undefined },
    })
  })

  it('reaches back past intervening messages to find the call', () => {
    const items = foldForDisplay([
      msg('a1', 1, 'assistant', [call('t1')]),
      msg('u1', 2, 'user', [text('meanwhile')]),
      msg('r1', 3, 'tool', [result('t1')]),
    ])
    expect(items).toHaveLength(2)
    const tool = items[0].blocks[0]
    expect(tool.kind === 'tool' && tool.result?.output).toBe('ok')
  })

  it('keeps an unmatched result as its own item', () => {
    const items = foldForDisplay([msg('r1', 1, 'tool', [result('gone', 'orphan')])])
    expect(items).toHaveLength(1)
    expect(items[0].role).toBe('tool')
    expect(items[0].blocks[0]).toEqual({ kind: 'toolResult', forId: 'gone', output: 'orphan' })
  })

  it('never overwrites a call that already holds a result', () => {
    const items = foldForDisplay([
      msg('a1', 1, 'assistant', [call('t1')]),
      msg('r1', 2, 'tool', [result('t1', 'first')]),
      msg('r2', 3, 'tool', [result('t1', 'duplicate')]),
    ])
    const tool = items[0].blocks[0]
    expect(tool.kind === 'tool' && tool.result?.output).toBe('first')
    // The duplicate is still visible, standalone.
    expect(items).toHaveLength(2)
    expect(items[1].uid).toBe('r2')
  })

  it('pairs interleaved parallel calls by id, not adjacency', () => {
    const items = foldForDisplay([
      msg('a1', 1, 'assistant', [call('t1', 'Read'), call('t2', 'Grep')]),
      msg('r2', 2, 'tool', [result('t2', 'grep out')]),
      msg('r1', 3, 'tool', [result('t1', 'read out')]),
    ])
    expect(items).toHaveLength(1)
    const [b1, b2] = items[0].blocks
    expect(b1.kind === 'tool' && b1.result?.output).toBe('read out')
    expect(b2.kind === 'tool' && b2.result?.output).toBe('grep out')
  })

  it('keeps images inside a tool message as standalone blocks', () => {
    const items = foldForDisplay([
      msg('a1', 1, 'assistant', [call('t1')]),
      msg('r1', 2, 'tool', [result('t1'), { kind: 'image', alt: 'screenshot' }]),
    ])
    expect(items).toHaveLength(2)
    expect(items[1].blocks).toEqual([{ kind: 'image', alt: 'screenshot' }])
  })

  it('does not mutate the input messages', () => {
    const assistant = msg('a1', 1, 'assistant', [call('t1')])
    foldForDisplay([assistant, msg('r1', 2, 'tool', [result('t1')])])
    expect(assistant.blocks[0]).toEqual({ kind: 'tool', id: 't1', name: 'Bash', input: 'ls' })
  })
})

describe('pending echoes', () => {
  it('makeEcho builds a local user message that sorts after every real seq', () => {
    const echo = makeEcho('do the thing', 41, 'n1', 1000)
    expect(echo.headSeq).toBe(41)
    expect(echo.message.uid).toBe('local:n1')
    expect(echo.message.role).toBe('user')
    expect(echo.message.blocks).toEqual([{ kind: 'text', text: 'do the thing' }])
    expect(echo.message.seq).toBeGreaterThan(Number.MAX_SAFE_INTEGER - 1)
    expect(echo.message.ts).toBe(1000)
  })

  it('keeps echoes while only older user messages have arrived', () => {
    const echoes = [makeEcho('hi', 10, 'n1')]
    const kept = pruneEchoes(echoes, [msg('u0', 10, 'user', [text('old send')])])
    expect(kept).toBe(echoes)
  })

  it('prunes an echo when a real user message lands above its head', () => {
    const echoes = [makeEcho('hi', 10, 'n1')]
    expect(pruneEchoes(echoes, [msg('u1', 11, 'user', [text('hi')])])).toEqual([])
  })

  it('does not prune on assistant messages above the head', () => {
    const echoes = [makeEcho('hi', 10, 'n1')]
    expect(pruneEchoes(echoes, [msg('a1', 12, 'assistant', [text('reply')])])).toBe(echoes)
  })

  it('prunes per echo: a newer send outlives an older one', () => {
    // First send's transcript copy arrives (seq 11); the second echo, fired
    // when the head had already advanced to 11, is still pending.
    const echoes = [makeEcho('first', 10, 'n1'), makeEcho('second', 11, 'n2')]
    const kept = pruneEchoes(echoes, [msg('u1', 11, 'user', [text('first')])])
    expect(kept).toHaveLength(1)
    expect(kept[0].message.uid).toBe('local:n2')
  })
})

describe('splitFences', () => {
  it('returns plain text as a single segment', () => {
    expect(splitFences('just words')).toEqual([{ code: false, text: 'just words' }])
  })

  it('splits a fenced block with a language tag', () => {
    expect(splitFences('before\n```ts\nconst x = 1\n```\nafter')).toEqual([
      { code: false, text: 'before' },
      { code: true, text: 'const x = 1', lang: 'ts' },
      { code: false, text: 'after' },
    ])
  })

  it('treats a bare fence as untagged code', () => {
    expect(splitFences('```\nplain\n```')).toEqual([{ code: true, text: 'plain', lang: undefined }])
  })

  it('runs an unclosed fence to the end (truncated message)', () => {
    expect(splitFences('intro\n```py\nprint(1)\nprint(2)')).toEqual([
      { code: false, text: 'intro' },
      { code: true, text: 'print(1)\nprint(2)', lang: 'py' },
    ])
  })

  it('returns nothing for empty text', () => {
    expect(splitFences('')).toEqual([])
  })
})

describe('question forms', () => {
  const questions = [
    {
      question: 'Which module?',
      header: 'Owner',
      options: [{ label: 'core' }, { label: 'cli' }, { label: 'shared' }],
    },
    {
      question: 'Which targets?',
      header: 'Targets',
      multiSelect: true,
      options: [{ label: 'node' }, { label: 'browser' }],
    },
  ]

  it('folds an answer result onto the question block', () => {
    const items = foldForDisplay([
      {
        uid: 'a1', seq: 1, role: 'assistant',
        blocks: [{ kind: 'question', id: 'q1', questions }],
      },
      {
        uid: 't1', seq: 2, role: 'tool',
        blocks: [{ kind: 'toolResult', forId: 'q1', output: 'answered', answers: { 'Which module?': 'core' } }],
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0].blocks[0]).toMatchObject({
      kind: 'question',
      result: { output: 'answered', answers: { 'Which module?': 'core' } },
    })
  })

  it('builds the verified key sequence: digits, Tab after multi, Enter to submit', () => {
    const steps = buildQuestionKeySequence(questions, [
      { optionIndexes: [1] },
      { optionIndexes: [0, 1] },
    ])
    expect(steps?.map((s) => s.data)).toEqual(['2', '1', '2', '\t', '\r'])
  })

  it('routes a free-typed answer through "Type something." (digit options+1)', () => {
    const steps = buildQuestionKeySequence(questions, [
      { optionIndexes: [], otherText: 'the new\nservice package' },
      { optionIndexes: [1] },
    ])
    // 4 = "Type something." for a 3-option question; newlines flattened so the
    // text can't submit itself early.
    expect(steps?.map((s) => s.data)).toEqual(['4', 'the new service package', '\r', '2', '\t', '\r'])
  })

  it('returns null when a question is unanswered or out of range', () => {
    expect(buildQuestionKeySequence(questions, [{ optionIndexes: [0] }])).toBeNull()
    expect(buildQuestionKeySequence(questions, [{ optionIndexes: [] }, { optionIndexes: [0] }])).toBeNull()
    expect(buildQuestionKeySequence(questions, [{ optionIndexes: [3] }, { optionIndexes: [0] }])).toBeNull()
  })

  it('chatAboutKey targets digit options+2 of the first question', () => {
    expect(chatAboutKey(questions)).toBe('5')
    expect(chatAboutKey([])).toBeNull()
  })
})
