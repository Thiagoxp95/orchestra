import { describe, expect, it } from 'vitest'
import {
  agentGateNotice,
  buildClaudeModelKeySteps,
  buildCodexModelKeySteps,
  buildQuestionKeySequence,
  chatAboutSteps,
  isDrivableQuestionForm,
  cutAtReset,
  cutQueued,
  effectiveModelSelection,
  foldForDisplay,
  groupWork,
  makeEcho,
  mergeMessages,
  adoptEchoPreviews,
  pruneEchoes,
  splitFences,
  splitUserImageTokens,
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

describe('cutAtReset', () => {
  const reset = (uid: string, seq: number): SeqChatMessage =>
    msg(uid, seq, 'system', [{ kind: 'reset' }])

  it('returns the list unchanged when no marker is held', () => {
    const held = [msg('a', 1, 'user', [text('hi')])]
    expect(cutAtReset(held)).toBe(held)
  })

  it('drops everything at and before the marker', () => {
    const out = cutAtReset([
      msg('old1', 1, 'user', [text('previous conversation')]),
      msg('old2', 2, 'assistant', [text('previous reply')]),
      reset('reset:fresh', 3),
      msg('new1', 4, 'user', [text('fresh conversation')]),
    ])
    expect(out.map((m) => m.uid)).toEqual(['new1'])
  })

  it('cuts at the newest marker when several are held', () => {
    const out = cutAtReset([
      reset('reset:a', 1),
      msg('b1', 2, 'user', [text('conversation b')]),
      reset('reset:c', 3),
      msg('c1', 4, 'user', [text('conversation c')]),
    ])
    expect(out.map((m) => m.uid)).toEqual(['c1'])
  })

  it('cuts to empty when the marker is the newest row (swap just landed)', () => {
    const out = cutAtReset([
      msg('old1', 1, 'user', [text('previous')]),
      reset('reset:fresh', 2),
    ])
    expect(out).toEqual([])
  })
})

describe('cutQueued', () => {
  const queued = (ts: string, seq: number, body: string): SeqChatMessage =>
    msg(`queued:${ts}`, seq, 'user', [{ kind: 'queued' }, text(body)])
  const marker = (seq: number, uids: string[]): SeqChatMessage =>
    msg(`unqueued:${uids.join(',')}`, seq, 'system', [{ kind: 'unqueued', uids }])

  it('leaves a queue that is still holding the message alone', () => {
    const held = [msg('a', 1, 'user', [text('deploy')]), queued('T1', 2, 'and the migration')]
    expect(cutQueued(held)).toBe(held)
  })

  it('drops the queued row and its marker once the message has been delivered', () => {
    // The delivered copy is its own row at its own seq — that pairing is the
    // whole reason the queued row has to go.
    const out = cutQueued([
      msg('a', 1, 'user', [text('deploy')]),
      queued('T1', 2, 'and the migration'),
      marker(3, ['queued:T1']),
      msg('d', 4, 'user', [text('and the migration')]),
    ])
    expect(out.map((m) => m.uid)).toEqual(['a', 'd'])
  })

  it('drops every row a drain marker names', () => {
    const out = cutQueued([
      queued('T1', 1, 'first'),
      queued('T2', 2, 'second'),
      marker(3, ['queued:T1', 'queued:T2']),
      msg('d', 4, 'user', [text('first')]),
    ])
    expect(out.map((m) => m.uid)).toEqual(['d'])
  })

  it('drops a marker whose queued row has already fallen out of the window', () => {
    const out = cutQueued([marker(1, ['queued:gone']), msg('a', 2, 'user', [text('hi')])])
    expect(out.map((m) => m.uid)).toEqual(['a'])
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

describe('adoptEchoPreviews', () => {
  it('hands the echo thumbnails to the message that replaced it', () => {
    const echoes = [makeEcho('look at this', 10, 'n1', 0, 1)]
    expect(adoptEchoPreviews(echoes, [msg('u1', 11, 'user', [text('look at this')])])).toEqual([
      { from: 'local:n1', to: 'u1' },
    ])
  })

  it('pairs in send order, one real message per echo', () => {
    const echoes = [makeEcho('first', 10, 'n1', 0, 1), makeEcho('second', 11, 'n2', 0, 1)]
    expect(
      adoptEchoPreviews(echoes, [
        msg('u2', 12, 'user', [text('second')]),
        msg('u1', 11, 'user', [text('first')]),
      ]),
    ).toEqual([
      { from: 'local:n1', to: 'u1' },
      { from: 'local:n2', to: 'u2' },
    ])
  })

  it('pairs nothing while the send is still in flight', () => {
    const echoes = [makeEcho('hi', 10, 'n1', 0, 1)]
    expect(adoptEchoPreviews(echoes, [msg('a1', 12, 'assistant', [text('reply')])])).toEqual([])
    expect(adoptEchoPreviews(echoes, [msg('u0', 10, 'user', [text('older')])])).toEqual([])
  })

  it('leaves the second echo unpaired when only one copy has landed', () => {
    // Two sends in flight, one transcript copy back: the older echo claims it,
    // and the newer one keeps its own thumbnails until its copy arrives.
    const echoes = [makeEcho('first', 10, 'n1', 0, 1), makeEcho('second', 11, 'n2', 0, 1)]
    expect(adoptEchoPreviews(echoes, [msg('u1', 11, 'user', [text('first')])])).toEqual([
      { from: 'local:n1', to: 'u1' },
    ])
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

  // Every expectation below matches a sequence driven against a real
  // claude-code 2.1.227 form over a PTY, asserted from the recorded transcript.
  const single = [questions[0]]

  it('answers one question with a bare digit — no trailing Enter', () => {
    // Verified: ["3"] alone recorded the third option and submitted; there is
    // no review screen on a one-question form, so an Enter would hit the
    // composer.
    const steps = buildQuestionKeySequence(single, [{ optionIndexes: [1] }])
    expect(steps?.map((s) => s.data)).toEqual(['2'])
  })

  it('answers a multi-question form with one digit each, then submits', () => {
    // Verified on a 3-question form: ["2","3","4",Enter] recorded
    // opt2/opt3/opt4. The old digit+Enter pairing recorded opt2/opt1/opt3 and
    // posted the leftover "4" into the conversation as a chat message.
    const two = [questions[0], { question: 'Which tool?', options: [{ label: 'lint' }, { label: 'fmt' }] }]
    const steps = buildQuestionKeySequence(two, [{ optionIndexes: [1] }, { optionIndexes: [0] }])
    expect(steps?.map((s) => s.data)).toEqual(['2', '1', '\r'])
  })

  it('commits a preview question with Enter, since its digit only moves focus', () => {
    // Verified: "2" alone on a one-question preview form left it open with
    // option 2 highlighted and recorded nothing.
    const preview = [{ ...questions[0], hasPreview: true }]
    expect(
      buildQuestionKeySequence(preview, [{ optionIndexes: [1] }])?.map((s) => s.data),
    ).toEqual(['2', '\r'])
    // Mixed shapes in one form key per question, not per form.
    const mixed = [preview[0], { question: 'Which tool?', options: [{ label: 'lint' }, { label: 'fmt' }] }]
    expect(
      buildQuestionKeySequence(mixed, [{ optionIndexes: [1] }, { optionIndexes: [0] }])?.map((s) => s.data),
    ).toEqual(['2', '\r', '1', '\r'])
  })

  it('refuses multi-select forms rather than half-answering them', () => {
    // questions[1] is multiSelect; its keying did not reproduce reliably.
    expect(isDrivableQuestionForm(questions)).toBe(false)
    expect(buildQuestionKeySequence(questions, [{ optionIndexes: [1] }, { optionIndexes: [0] }])).toBeNull()
    expect(isDrivableQuestionForm(single)).toBe(true)
  })

  it('returns null when a question is unanswered or out of range', () => {
    expect(buildQuestionKeySequence(single, [])).toBeNull()
    expect(buildQuestionKeySequence(single, [{ optionIndexes: [] }])).toBeNull()
    expect(buildQuestionKeySequence(single, [{ optionIndexes: [3] }])).toBeNull()
  })

  it('reaches "Chat about this" by digit without previews and by arrows with them', () => {
    // Numbered options+2 on a plain form, where the digit selects outright;
    // unnumbered on a preview form, so walk focus down and select with Enter.
    expect(chatAboutSteps(single)?.map((s) => s.data)).toEqual(['5'])
    const preview = [{ ...questions[0], hasPreview: true }]
    expect(chatAboutSteps(preview)?.map((s) => s.data)).toEqual([
      '\x1b[B', '\x1b[B', '\x1b[B', '\r',
    ])
    expect(chatAboutSteps([])).toBeNull()
  })
})

describe('makeEcho with images', () => {
  it('leads with image blocks in typed order (paths before text)', () => {
    const echo = makeEcho('look at these', 5, 'n1', 123, 2)
    expect(echo.message.blocks).toEqual([
      { kind: 'image' },
      { kind: 'image' },
      { kind: 'text', text: 'look at these' },
    ])
  })

  it('supports image-only sends (no empty text block)', () => {
    const echo = makeEcho('', 5, 'n1', 123, 1)
    expect(echo.message.blocks).toEqual([{ kind: 'image' }])
  })
})

describe('splitUserImageTokens', () => {
  it('strips desktop image paths and counts them', () => {
    const { text: t, imageCount } = splitUserImageTokens(
      '/Users/me/.orchestra/remote-images/remote-1-1.png /Users/me/.orchestra/remote-images/remote-1-2.jpg fix the header',
    )
    expect(t).toBe('fix the header')
    expect(imageCount).toBe(2)
  })

  it('strips claude "[Image #N]" placeholders too', () => {
    const { text: t, imageCount } = splitUserImageTokens('[Image #1] what is this?')
    expect(t).toBe('what is this?')
    expect(imageCount).toBe(1)
  })

  it('leaves ordinary text alone', () => {
    expect(splitUserImageTokens('deploy the web app')).toEqual({
      text: 'deploy the web app',
      imageCount: 0,
    })
  })
})

describe('groupWork', () => {
  const tool = (id: string): ChatBlock => ({ kind: 'tool', id, name: 'Bash', input: 'ls' })
  const thinking: ChatBlock = { kind: 'thinking', text: 'hmm' }
  const work = (uid: string, blocks: ChatBlock[]): SeqChatMessage =>
    msg(uid, 0, 'assistant', blocks)

  it('folds a settled run of 3+ steps into one work row', () => {
    const rows = groupWork(
      [
        work('w1', [thinking, tool('a')]),
        work('w2', [tool('b')]),
        msg('t1', 0, 'assistant', [text('done')]),
      ],
      false,
    )
    expect(rows.map((r) => r.kind)).toEqual(['work', 'item'])
    expect(rows[0]).toMatchObject({ uid: 'work:w1', steps: 3, live: false })
  })

  it('leaves short runs unfolded', () => {
    const rows = groupWork(
      [work('w1', [tool('a')]), msg('t1', 0, 'assistant', [text('done')])],
      false,
    )
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item'])
  })

  it('keeps the newest rows visible while the turn is running', () => {
    const rows = groupWork(
      [work('w1', [tool('a'), tool('b'), tool('c')]), work('w2', [tool('d')]), work('w3', [tool('e')])],
      true,
    )
    // w1 folds (3 steps), w2/w3 stay live.
    expect(rows.map((r) => r.kind)).toEqual(['work', 'item', 'item'])
    expect(rows[0]).toMatchObject({ live: true, steps: 3 })
  })

  it('folds a trailing run fully once the agent goes idle', () => {
    const rows = groupWork(
      [work('w1', [tool('a'), tool('b')]), work('w2', [tool('c')])],
      false,
    )
    expect(rows.map((r) => r.kind)).toEqual(['work'])
    expect(rows[0]).toMatchObject({ live: false, steps: 3 })
  })

  it('never folds text or question items', () => {
    const rows = groupWork(
      [
        work('w1', [tool('a')]),
        msg('q1', 0, 'assistant', [
          { kind: 'question', id: 'q', questions: [{ question: 'x', options: [{ label: 'y' }] }] },
        ]),
        work('w2', [tool('b')]),
      ],
      false,
    )
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item', 'item'])
  })
})

describe('agentGateNotice', () => {
  // Round 6 of "the picker is broken": codex self-updated, printed "Please
  // restart Codex", and quit — PTY alive, shell at the prompt, and every
  // picker step and chat send typed itself into zsh with no feedback anywhere.
  // The gate exists so ALL composer actions refuse that state out loud.
  it('is silent when an agent is running', () => {
    expect(agentGateNotice('claude', false)).toBeNull()
    expect(agentGateNotice('codex', false)).toBeNull()
  })

  it('names the dead-CLI state (live PTY, no agent)', () => {
    expect(agentGateNotice(undefined, false)).toMatch(/No agent is running/)
  })

  it('prefers the dead-PTY wording when the whole session ended', () => {
    // exited implies the agent is unreachable too; the more specific verdict
    // must win no matter what the geo watcher last reported.
    expect(agentGateNotice(undefined, true)).toMatch(/Session ended/)
    expect(agentGateNotice('claude', true)).toMatch(/Session ended/)
  })
})

describe('model switch key sequences', () => {
  // TYPED, never pasted: claude-code 2.1.221 drops the argument on a pasted
  // `/effort <level>` and opens its dialog instead, so the switch silently
  // did nothing. Guard the shape so nobody "simplifies" it back to a paste.
  it('claude: one Ctrl-U + typed command + CR per slash command', () => {
    const steps = buildClaudeModelKeySteps('fable', 'xhigh')
    expect(steps?.map((s) => s.data)).toEqual([
      '\x15',
      '/model fable',
      '\r',
      '\x15',
      '/effort xhigh',
      '\r',
      // conditional — only sent if the confirmation dialog actually paints
      '1',
      '\r',
    ])
  })

  // 2.1.222 asks "Change effort level?" when the conversation is cached at the
  // old level; an unanswered dialog leaves the switch un-applied. The digit is
  // guarded so an absent dialog never eats a stray "1" as a chat message.
  it('claude: effort confirmation steps are screen-guarded, and only on /effort', () => {
    const steps = buildClaudeModelKeySteps('fable', 'xhigh') ?? []
    const guarded = steps.filter((s) => s.ifScreenContains)
    expect(guarded.map((s) => s.data)).toEqual(['1', '\r'])
    expect(guarded.every((s) => s.ifScreenContains === 'Change effort level?')).toBe(true)
    // model-only switches carry no conditional steps
    expect((buildClaudeModelKeySteps('opus') ?? []).some((s) => s.ifScreenContains)).toBe(false)
  })

  it('claude: never wraps a command in a bracketed paste', () => {
    const data = buildClaudeModelKeySteps('opus', 'max')?.map((s) => s.data).join('')
    expect(data).not.toContain('\x1b[200~')
  })

  it('claude: either half alone works; neither returns null', () => {
    expect(buildClaudeModelKeySteps(undefined, 'low')?.map((s) => s.data)).toEqual([
      '\x15',
      '/effort low',
      '\r',
      '1',
      '\r',
    ])
    expect(buildClaudeModelKeySteps()).toBeNull()
  })

  it('claude: ultracode rides the standard effort sequence, confirmation included', () => {
    const steps = buildClaudeModelKeySteps(undefined, 'ultracode') ?? []
    expect(steps.map((s) => s.data)).toEqual(['\x15', '/effort ultracode', '\r', '1', '\r'])
    expect(steps.filter((s) => s.ifScreenContains).map((s) => s.data)).toEqual(['1', '\r'])
  })

  it('codex: clears, types /model, opens picker, then digit-picks model and effort', () => {
    const steps = buildCodexModelKeySteps('2', '3')
    expect(steps?.map((s) => s.data)).toEqual(['\x15', '/model', '\r', '2', '3'])
  })

  it('codex: "5,N" effort routes through the Advanced Reasoning submenu', () => {
    const steps = buildCodexModelKeySteps('1', '5,2')
    expect(steps?.map((s) => s.data)).toEqual(['\x15', '/model', '\r', '1', '5', '2'])
  })

  it('codex: rejects non-digit rows', () => {
    expect(buildCodexModelKeySteps('x', '3')).toBeNull()
    expect(buildCodexModelKeySteps('1', 'high')).toBeNull()
  })
})

describe('effectiveModelSelection', () => {
  it('maps claude transcript ids onto the picker aliases', () => {
    expect(effectiveModelSelection('claude', {}, 'claude-fable-5', 'xhigh')).toEqual({
      model: 'fable',
      effort: 'xhigh',
    })
    expect(effectiveModelSelection('claude', {}, 'claude-haiku-4-5', 'low').model).toBe('haiku')
  })

  it('maps codex display names onto the picker row digits', () => {
    expect(effectiveModelSelection('codex', {}, 'gpt-5.6-sol', 'high')).toEqual({
      model: '1',
      effort: '3',
    })
    expect(effectiveModelSelection('codex', {}, 'gpt-5.4-mini', 'extra high').effort).toBe('4')
  })

  it('passes an unrecognized raw value through for a verbatim label', () => {
    expect(effectiveModelSelection('claude', {}, 'claude-nova-6', undefined).model).toBe(
      'claude-nova-6',
    )
  })

  it('is empty when neither the mirror nor this pane knows anything', () => {
    expect(effectiveModelSelection('claude', {})).toEqual({ model: undefined, effort: undefined })
  })

  it('keeps a locally-applied choice while the mirror still reports its apply-time baseline', () => {
    const local = { model: 'opus', baseModel: 'claude-fable-5', effort: 'low', baseEffort: 'xhigh' }
    expect(effectiveModelSelection('claude', local, 'claude-fable-5', 'xhigh')).toEqual({
      model: 'opus',
      effort: 'low',
    })
    // …including in a session so fresh the mirror knew nothing at apply time.
    expect(effectiveModelSelection('claude', { model: 'opus' })).toEqual({
      model: 'opus',
      effort: undefined,
    })
  })

  it('yields to the mirror the moment it moves off the baseline', () => {
    const local = { model: 'opus', baseModel: 'claude-fable-5' }
    expect(effectiveModelSelection('claude', local, 'claude-opus-5', 'high')).toEqual({
      model: 'opus',
      effort: 'high',
    })
    // The mirror moved to something else entirely (a desktop-side switch): the
    // stale local label loses.
    expect(effectiveModelSelection('claude', local, 'claude-sonnet-5', undefined).model).toBe(
      'sonnet',
    )
  })

  // The CLI records ultracode as effort "xhigh" (a flag layered on xhigh, kept
  // in a separate settings key), so the mirror can never confirm it. Applied at
  // an xhigh baseline the label sticks — the mirror never moves. Applied from
  // any other level, the mirror's move to "xhigh" dethrones the label even
  // though ultracode is genuinely active. Documented trade-off, not a bug.
  it('ultracode: label survives only when applied at an xhigh baseline', () => {
    const atXhigh = { effort: 'ultracode', baseEffort: 'xhigh' }
    expect(effectiveModelSelection('claude', atXhigh, 'claude-fable-5', 'xhigh').effort).toBe(
      'ultracode',
    )
    const fromHigh = { effort: 'ultracode', baseEffort: 'high' }
    expect(effectiveModelSelection('claude', fromHigh, 'claude-fable-5', 'xhigh').effort).toBe(
      'xhigh',
    )
  })

  it('decides model and effort independently', () => {
    // Effort was applied here and the mirror hasn't moved; the model half only
    // ever came from the mirror.
    const local = { effort: 'max', baseEffort: 'high' }
    expect(effectiveModelSelection('claude', local, 'claude-fable-5', 'high')).toEqual({
      model: 'fable',
      effort: 'max',
    })
  })
})
