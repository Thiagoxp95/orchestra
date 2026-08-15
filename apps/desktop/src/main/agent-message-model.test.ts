import { describe, expect, it } from 'vitest'
import {
  MAX_BLOCKS_PER_MESSAGE,
  TEXT_CAP,
  THINKING_CAP,
  TOOL_INPUT_CAP,
  TOOL_RESULT_CAP,
  flattenToolResult,
  parseClaudeLine,
  parseClaudeQueueOp,
  parseCodexLine,
  parseQuestionInput,
  summarizeToolInput,
  truncateMiddle,
} from './agent-message-model'
import {
  CLAUDE_ASK_ANSWER_LINE,
  CLAUDE_ASK_MALFORMED_LINE,
  CLAUDE_ASK_QUESTION_LINE,
  CLAUDE_ASK_REJECT_LINE,
  CLAUDE_ASSISTANT_EMPTY_THINKING_LINE,
  CLAUDE_ASSISTANT_LINE,
  CLAUDE_CAVEAT_LINE,
  CLAUDE_COMMAND_LINE,
  CLAUDE_COMMAND_NO_ARGS_LINE,
  CLAUDE_COMPACT_SUMMARY_LINE,
  CLAUDE_HOOK_LINE,
  CLAUDE_INTERRUPT_LINE,
  CLAUDE_INTERRUPT_TOOL_LINE,
  CLAUDE_META_NOTE_LINE,
  CLAUDE_META_TOOL_RESULT_LINE,
  CLAUDE_MIXED_REMINDER_LINE,
  CLAUDE_NON_CONVERSATION_LINES,
  CLAUDE_NO_UUID_LINE,
  CLAUDE_QUEUED_COMMAND_IMAGE_LINE,
  CLAUDE_QUEUED_COMMAND_LINE,
  CLAUDE_QUEUE_DEQUEUE_LINE,
  CLAUDE_QUEUE_ENQUEUE_LINE,
  CLAUDE_QUEUE_REMOVE_LINE,
  CLAUDE_QUEUE_SYNTHETIC_LINE,
  CLAUDE_QUEUE_TEXT,
  CLAUDE_QUEUE_TS,
  CLAUDE_SIDECHAIN_LINE,
  CLAUDE_STDOUT_LINE,
  CLAUDE_SYSTEM_REMINDER_LINE,
  CLAUDE_TOOL_RESULT_ERROR_LINE,
  CLAUDE_TOOL_RESULT_RICH_LINE,
  CLAUDE_TOOL_RESULT_STRING_LINE,
  CLAUDE_TS,
  CLAUDE_TS_MS,
  CLAUDE_USER_BLOCKS_LINE,
  CLAUDE_USER_STRING_LINE,
} from './__fixtures__/claude-transcript-lines'
import {
  CODEX_ASSISTANT_LINE,
  CODEX_CUSTOM_CALL_LINE,
  CODEX_CUSTOM_OUTPUT_LINE,
  CODEX_DEVELOPER_LINE,
  CODEX_EVENT_AGENT_LINE,
  CODEX_EVENT_USER_LINE,
  CODEX_FILE_BASE,
  CODEX_FUNCTION_CALL_BAD_ARGS_LINE,
  CODEX_FUNCTION_CALL_LINE,
  CODEX_FUNCTION_CALL_SHELL_LINE,
  CODEX_FUNCTION_OUTPUT_LINE,
  CODEX_LOCAL_SHELL_LINE,
  CODEX_REASONING_ENCRYPTED_LINE,
  CODEX_REASONING_LINE,
  CODEX_SESSION_META_LINE,
  CODEX_TS_MS,
  CODEX_TURN_CONTEXT_LINE,
  CODEX_USER_ABORT_LINE,
  CODEX_USER_ENV_LINE,
  CODEX_USER_IMAGE_LINE,
  CODEX_USER_INSTRUCTIONS_LINE,
  CODEX_USER_LINE,
  CODEX_USER_MARKER_LINE,
  CODEX_USER_PLUGINS_LINE,
  CODEX_USER_SUBAGENT_LINE,
  CODEX_WEB_SEARCH_LINE,
  CODEX_WORLD_STATE_LINE,
} from './__fixtures__/codex-rollout-lines'

const GARBAGE_LINES = ['', '   ', 'not json', '{', '{"type":', '[1,2,3]', '"a string"', 'null', '42']

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 100, 60, 30)).toBe('hello')
  })

  it('keeps head and tail with an ellipsis line between', () => {
    const text = 'H'.repeat(60) + 'M'.repeat(100) + 'T'.repeat(40)
    const out = truncateMiddle(text, 100, 60, 30)
    expect(out).toBe('H'.repeat(60) + '\n…\n' + 'T'.repeat(30))
  })
})

describe('summarizeToolInput', () => {
  it('maps each named Claude tool to its identifying field', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la', description: 'List' })).toBe('ls -la')
    expect(summarizeToolInput('Read', { file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(summarizeToolInput('Write', { file_path: '/tmp/b.ts', content: 'x' })).toBe('/tmp/b.ts')
    expect(summarizeToolInput('Edit', { file_path: '/tmp/c.ts', old_string: 'x' })).toBe('/tmp/c.ts')
    expect(summarizeToolInput('Grep', { pattern: 'foo.*bar' })).toBe('foo.*bar')
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(summarizeToolInput('Task', { description: 'Explore the repo', prompt: 'long…' })).toBe('Explore the repo')
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(summarizeToolInput('WebSearch', { query: 'vitest docs' })).toBe('vitest docs')
    expect(summarizeToolInput('TodoWrite', { todos: [{ content: 'a' }] })).toBe('update todos')
  })

  it('falls back to well-known keys for unnamed tools (codex, MCP)', () => {
    expect(summarizeToolInput('exec_command', { cmd: 'cat p.json', workdir: '/x' })).toBe('cat p.json')
    expect(summarizeToolInput('shell', { command: ['bash', '-lc', 'echo hi'] })).toBe('bash -lc echo hi')
    expect(summarizeToolInput('mcp__thing__fetch', { url: 'https://example.com/x' })).toBe('https://example.com/x')
  })

  it('passes raw string input through', () => {
    expect(summarizeToolInput('exec', 'text("hi")')).toBe('text("hi")')
  })

  it('compact-JSONs inputs with no recognizable key', () => {
    expect(summarizeToolInput('update_plan', { plan: [{ step: 'a' }] })).toBe('{"plan":[{"step":"a"}]}')
  })

  it('returns empty for missing input', () => {
    expect(summarizeToolInput('Mystery', undefined)).toBe('')
  })

  it('caps at TOOL_INPUT_CAP', () => {
    const out = summarizeToolInput('Bash', { command: 'x'.repeat(2 * TOOL_INPUT_CAP) })
    expect(out.length).toBe(TOOL_INPUT_CAP)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('flattenToolResult', () => {
  it('passes strings through', () => {
    expect(flattenToolResult('exit 0')).toBe('exit 0')
  })

  it('joins text-ish blocks and drops unknown kinds', () => {
    expect(flattenToolResult([
      { type: 'text', text: 'a' },
      { type: 'tool_reference', ref: 'x' },
      { type: 'input_text', text: 'b' },
    ])).toBe('a\nb')
  })

  it('stringifies non-list objects', () => {
    expect(flattenToolResult({ ok: true })).toBe('{"ok":true}')
  })

  it('caps at TOOL_RESULT_CAP with head and tail preserved', () => {
    const out = flattenToolResult('h'.repeat(2000) + 't'.repeat(2000))
    expect(out.length).toBeLessThan(TOOL_RESULT_CAP)
    expect(out.startsWith('hhh')).toBe(true)
    expect(out.endsWith('ttt')).toBe(true)
    expect(out).toContain('\n…\n')
  })
})

describe('parseClaudeLine', () => {
  it('returns [] for garbage lines', () => {
    for (const bad of GARBAGE_LINES) expect(parseClaudeLine(bad)).toEqual([])
  })

  it('parses a plain user prompt (string content)', () => {
    expect(parseClaudeLine(CLAUDE_USER_STRING_LINE)).toEqual([{
      uid: 'uu-user-1',
      role: 'user',
      blocks: [{ kind: 'text', text: 'Rename the widget factory' }],
      ts: CLAUDE_TS_MS,
    }])
  })

  it('parses user text blocks plus pasted images', () => {
    expect(parseClaudeLine(CLAUDE_USER_BLOCKS_LINE)).toEqual([{
      uid: 'uu-user-2',
      role: 'user',
      blocks: [
        { kind: 'text', text: 'Look at this screenshot' },
        { kind: 'image' },
      ],
      ts: CLAUDE_TS_MS,
    }])
  })

  it('parses an assistant turn: thinking + text + tool_use', () => {
    expect(parseClaudeLine(CLAUDE_ASSISTANT_LINE)).toEqual([{
      uid: 'uu-asst-1',
      role: 'assistant',
      blocks: [
        { kind: 'thinking', text: 'The factory name is stale.' },
        { kind: 'text', text: 'Renaming it now.' },
        { kind: 'tool', id: 'toolu_001', name: 'Bash', input: 'git grep -l WidgetFactory' },
      ],
      ts: CLAUDE_TS_MS,
    }])
  })

  it('drops an assistant record whose only content is an empty thinking block', () => {
    expect(parseClaudeLine(CLAUDE_ASSISTANT_EMPTY_THINKING_LINE)).toEqual([])
  })

  it('maps an all-tool_result user record to role tool with pairing id', () => {
    expect(parseClaudeLine(CLAUDE_TOOL_RESULT_STRING_LINE)).toEqual([{
      uid: 'uu-tool-1',
      role: 'tool',
      blocks: [{ kind: 'toolResult', forId: 'toolu_001', output: 'src/factory.ts' }],
      ts: CLAUDE_TS_MS,
    }])
  })

  it('marks error results', () => {
    const [message] = parseClaudeLine(CLAUDE_TOOL_RESULT_ERROR_LINE)
    expect(message.blocks).toEqual([
      { kind: 'toolResult', forId: 'toolu_002', output: 'command not found: frob', isError: true },
    ])
  })

  it('surfaces images inside tool_result content as image blocks', () => {
    const [message] = parseClaudeLine(CLAUDE_TOOL_RESULT_RICH_LINE)
    expect(message.role).toBe('tool')
    expect(message.blocks).toEqual([
      { kind: 'toolResult', forId: 'toolu_003', output: 'Screenshot captured' },
      { kind: 'image' },
    ])
  })

  it('keeps isMeta records whose content is entirely tool_result (as role tool)', () => {
    const [message] = parseClaudeLine(CLAUDE_META_TOOL_RESULT_LINE)
    expect(message.role).toBe('tool')
    expect(message.blocks).toEqual([{ kind: 'toolResult', forId: 'toolu_004', output: 'ok' }])
  })

  it('parses AskUserQuestion into a structured question block', () => {
    expect(parseClaudeLine(CLAUDE_ASK_QUESTION_LINE)).toEqual([{
      // Keyed on the tool_use id, NOT the record uuid, so this upserts onto the
      // row the PreToolUse hook already pushed when the form opened.
      uid: 'askq:toolu_ask1',
      role: 'assistant',
      blocks: [
        { kind: 'text', text: 'Quick check before I refactor:' },
        {
          kind: 'question',
          id: 'toolu_ask1',
          questions: [
            {
              question: 'Which module should own the parser?',
              header: 'Owner',
              options: [
                { label: 'core', description: 'Keep it near the model types' },
                { label: 'cli', description: 'Keep it near the consumers' },
              ],
            },
            {
              question: 'Which targets should I test?',
              header: 'Targets',
              multiSelect: true,
              options: [{ label: 'node', description: 'The daemon runtime' }, { label: 'browser' }],
            },
          ],
        },
      ],
      ts: CLAUDE_TS_MS,
    }])
  })

  it('falls back to a generic tool row for a malformed AskUserQuestion', () => {
    const [message] = parseClaudeLine(CLAUDE_ASK_MALFORMED_LINE)
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks[0]).toMatchObject({ kind: 'tool', name: 'AskUserQuestion', id: 'toolu_ask2' })
  })

  it('attaches structured answers from toolUseResult to the question result', () => {
    const [message] = parseClaudeLine(CLAUDE_ASK_ANSWER_LINE)
    expect(message.role).toBe('tool')
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks[0]).toMatchObject({
      kind: 'toolResult',
      forId: 'toolu_ask1',
      answers: [
        { question: 'Which module should own the parser?', answer: 'core' },
        { question: 'Which targets should I test?', answer: 'node, browser' },
      ],
    })
  })

  // The regression that froze the phone chat twice: a question containing an
  // em dash (or a `$` prefix / control char) used to become an OBJECT KEY in
  // `answers`, which the Convex client refuses to serialize — so the answered
  // record's batch was rejected on every retry and nothing after it ever
  // mirrored. Every parsed message must survive convexToJson.
  it('parses answers to em-dash / $-prefixed questions into a Convex-safe shape', async () => {
    const { convexToJson } = await import('convex/values')
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-emdash',
      timestamp: '2026-08-15T17:05:06.205Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_ask1', content: 'Your questions have been answered' }],
      },
      toolUseResult: {
        answers: {
          'Once private — how should it authenticate?': 'PAT',
          '$200 receipt, you claim $120?': 'yes',
          'Line one\nline two?': 'ok',
        },
      },
    })
    const [message] = parseClaudeLine(line)
    expect(message.blocks[0]).toMatchObject({ kind: 'toolResult', forId: 'toolu_ask1' })
    expect(() => convexToJson({ ...message, seq: 1 } as never)).not.toThrow()
  })

  it('parses a dismissed question form as a plain error result (no answers)', () => {
    const [message] = parseClaudeLine(CLAUDE_ASK_REJECT_LINE)
    expect(message.blocks).toEqual([{
      kind: 'toolResult',
      forId: 'toolu_ask1',
      output: "The user doesn't want to proceed with this tool use.",
      isError: true,
    }])
  })

  it('skips other isMeta records', () => {
    expect(parseClaudeLine(CLAUDE_META_NOTE_LINE)).toEqual([])
  })

  it('skips sidechain and compact-summary records', () => {
    expect(parseClaudeLine(CLAUDE_SIDECHAIN_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_COMPACT_SUMMARY_LINE)).toEqual([])
  })

  it('renders command envelopes as the literal command text', () => {
    expect(parseClaudeLine(CLAUDE_COMMAND_LINE)[0].blocks).toEqual([
      { kind: 'text', text: '/goal ship the parser' },
    ])
  })

  // The switch echo carries the RESOLVED name ("Opus 5"), the envelope only the
  // alias the person typed — so the echo is the row worth keeping, and showing
  // both would double every switch.
  it('renders a model/effort switch as one system row, not a /model bubble', () => {
    expect(parseClaudeLine(CLAUDE_COMMAND_NO_ARGS_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_STDOUT_LINE)).toEqual([
      { uid: 'uu-stdout-1', role: 'system', blocks: [{ kind: 'text', text: 'Model → Test 1' }], ts: CLAUDE_TS_MS },
    ])
  })

  // Verbatim from a real transcript: the CLI bolds the model name with SGR
  // codes and tacks its "saved as your default…" footnote onto both commands.
  it('strips the ANSI bolding and the saved-as-default footnote', () => {
    const stdout = (uuid: string, text: string) => JSON.stringify({
      type: 'user', uuid, timestamp: '2026-07-27T10:00:00Z',
      message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
    })
    expect(parseClaudeLine(stdout('s1', 'Set model to \u001b[1mOpus 5\u001b[22m and saved as your default for new sessions'))[0].blocks)
      .toEqual([{ kind: 'text', text: 'Model → Opus 5' }])
    expect(parseClaudeLine(stdout('s2', 'Set effort level to medium (saved as your default for new sessions): Balanced approach with standard implementation and testing'))[0].blocks)
      .toEqual([{ kind: 'text', text: 'Effort → medium' }])
  })

  it('skips synthetic user records (reminders, hook output, caveat)', () => {
    expect(parseClaudeLine(CLAUDE_SYSTEM_REMINDER_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_HOOK_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_CAVEAT_LINE)).toEqual([])
  })

  it('leaves an unrelated local-command stdout filtered out', () => {
    const other = JSON.stringify({
      type: 'user', uuid: 'so-1', timestamp: '2026-07-27T10:00:00Z',
      message: { role: 'user', content: '<local-command-stdout>Cleared 4 items</local-command-stdout>' },
    })
    expect(parseClaudeLine(other)).toEqual([])
  })

  it('skips harness task-notification turns (both framing variants)', () => {
    const framed = JSON.stringify({
      type: 'user', uuid: 'tn-1', timestamp: '2026-07-27T10:00:00Z',
      message: { role: 'user', content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nblah\n<task-notification>...</task-notification>' },
    })
    const bare = JSON.stringify({
      type: 'user', uuid: 'tn-2', timestamp: '2026-07-27T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' }] },
    })
    expect(parseClaudeLine(framed)).toEqual([])
    expect(parseClaudeLine(bare)).toEqual([])
  })

  it('drops only the reminder block when it rides along with a real prompt', () => {
    expect(parseClaudeLine(CLAUDE_MIXED_REMINDER_LINE)[0].blocks).toEqual([
      { kind: 'text', text: 'Now fix the flaky test' },
    ])
  })

  it('maps both interrupt boilerplate variants to a system Interrupted marker', () => {
    for (const fixtureLine of [CLAUDE_INTERRUPT_LINE, CLAUDE_INTERRUPT_TOOL_LINE]) {
      const [message] = parseClaudeLine(fixtureLine)
      expect(message.role).toBe('system')
      expect(message.blocks).toEqual([{ kind: 'text', text: 'Interrupted' }])
    }
  })

  it('skips records without a uuid (no stable identity to dedupe on)', () => {
    expect(parseClaudeLine(CLAUDE_NO_UUID_LINE)).toEqual([])
  })

  it('skips every non-conversation record type', () => {
    for (const record of CLAUDE_NON_CONVERSATION_LINES) {
      expect(parseClaudeLine(record)).toEqual([])
    }
  })

  // ── The message queue ──────────────────────────────────────────────────────
  // Sending while the agent is working queues the message; every record about
  // it used to parse to nothing, so the phone showed no trace of a send until
  // (and unless) claude re-recorded it as ordinary conversation.

  it('mirrors an enqueued message as a queued user bubble', () => {
    const [message] = parseClaudeLine(CLAUDE_QUEUE_ENQUEUE_LINE)
    expect(message).toEqual({
      uid: `queued:${CLAUDE_QUEUE_TS}`,
      role: 'user',
      blocks: [{ kind: 'queued' }, { kind: 'text', text: CLAUDE_QUEUE_TEXT }],
      ts: Date.parse(CLAUDE_QUEUE_TS),
    })
  })

  it('mirrors a steered message from its queued_command attachment', () => {
    // The only record of a mid-turn steer as conversation — there is never a
    // `user` record for one — and it keys on its own uuid so it lands as a new
    // row at the point it actually reached the model.
    const [message] = parseClaudeLine(CLAUDE_QUEUED_COMMAND_LINE)
    expect(message).toEqual({
      uid: 'uu-queued-1',
      role: 'user',
      blocks: [{ kind: 'text', text: CLAUDE_QUEUE_TEXT }],
      ts: Date.parse(CLAUDE_QUEUE_TS),
    })
  })

  it('mirrors a steered message whose prompt is a content-block array', () => {
    // An image-bearing steer records its prompt as blocks, not a string. Read
    // as a string it parsed to nothing — and because the `remove` marker takes
    // the queued row back down, a photo sent from the phone mid-turn left NO
    // trace in the chat while the terminal showed it delivered.
    expect(parseClaudeLine(CLAUDE_QUEUED_COMMAND_IMAGE_LINE)).toEqual([
      {
        uid: 'uu-queued-2',
        role: 'user',
        blocks: [{ kind: 'text', text: '[Image #1]' }, { kind: 'image' }],
        ts: Date.parse(CLAUDE_QUEUE_TS),
      },
    ])
  })

  it('ignores queue records for harness plumbing and for other operations', () => {
    expect(parseClaudeLine(CLAUDE_QUEUE_SYNTHETIC_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_QUEUE_REMOVE_LINE)).toEqual([])
    expect(parseClaudeLine(CLAUDE_QUEUE_DEQUEUE_LINE)).toEqual([])
  })

  it('reads what each queue operation does to the queue', () => {
    expect(parseClaudeQueueOp(CLAUDE_QUEUE_ENQUEUE_LINE)).toEqual({
      op: 'enqueue',
      uid: `queued:${CLAUDE_QUEUE_TS}`,
      text: CLAUDE_QUEUE_TEXT,
    })
    expect(parseClaudeQueueOp(CLAUDE_QUEUE_REMOVE_LINE)).toEqual({
      op: 'remove',
      text: CLAUDE_QUEUE_TEXT,
    })
    expect(parseClaudeQueueOp(CLAUDE_QUEUE_DEQUEUE_LINE)).toEqual({ op: 'drain' })
    expect(parseClaudeQueueOp(CLAUDE_QUEUE_SYNTHETIC_LINE)).toBeNull()
    expect(parseClaudeQueueOp(CLAUDE_USER_STRING_LINE)).toBeNull()
    expect(parseClaudeQueueOp('not json')).toBeNull()
  })

  it('middle-truncates long user text at TEXT_CAP', () => {
    const long = 'a'.repeat(4000) + 'm'.repeat(3000) + 'z'.repeat(1500)
    const record = JSON.stringify({
      type: 'user', uuid: 'uu-long-1', timestamp: CLAUDE_TS,
      message: { role: 'user', content: long },
    })
    const [message] = parseClaudeLine(record)
    const block = message.blocks[0]
    if (block.kind !== 'text') throw new Error('expected text block')
    expect(block.text.length).toBeLessThan(TEXT_CAP)
    expect(block.text.startsWith('aaa')).toBe(true)
    expect(block.text.endsWith('zzz')).toBe(true)
    expect(block.text).toContain('\n…\n')
  })

  it('truncates thinking at THINKING_CAP', () => {
    const record = JSON.stringify({
      type: 'assistant', uuid: 'uu-long-2', timestamp: CLAUDE_TS,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(3000) }] },
    })
    const block = parseClaudeLine(record)[0].blocks[0]
    if (block.kind !== 'thinking') throw new Error('expected thinking block')
    expect(block.text.length).toBeLessThan(THINKING_CAP)
  })

  it('caps a message at MAX_BLOCKS_PER_MESSAGE blocks', () => {
    const results = Array.from({ length: 40 }, (_, i) => (
      { type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'ok' }
    ))
    const record = JSON.stringify({
      type: 'user', uuid: 'uu-many-1', timestamp: CLAUDE_TS,
      message: { role: 'user', content: results },
    })
    expect(parseClaudeLine(record)[0].blocks).toHaveLength(MAX_BLOCKS_PER_MESSAGE)
  })
})

describe('parseCodexLine', () => {
  const parse = (fixtureLine: string, lineNo = 7) => parseCodexLine(fixtureLine, lineNo, CODEX_FILE_BASE)

  it('returns [] for garbage lines', () => {
    for (const bad of GARBAGE_LINES) expect(parse(bad)).toEqual([])
  })

  it('skips non-conversation record types', () => {
    expect(parse(CODEX_SESSION_META_LINE)).toEqual([])
    expect(parse(CODEX_TURN_CONTEXT_LINE)).toEqual([])
    expect(parse(CODEX_WORLD_STATE_LINE)).toEqual([])
  })

  it('skips event_msg duplicates of response_item content', () => {
    expect(parse(CODEX_EVENT_USER_LINE)).toEqual([])
    expect(parse(CODEX_EVENT_AGENT_LINE)).toEqual([])
  })

  it('parses a user message with a positional uid', () => {
    expect(parse(CODEX_USER_LINE, 12)).toEqual([{
      uid: `${CODEX_FILE_BASE}:12`,
      role: 'user',
      blocks: [{ kind: 'text', text: 'Bump the parser version' }],
      ts: CODEX_TS_MS,
    }])
  })

  it('keeps images but drops the file-list preamble on attachment-only turns', () => {
    expect(parse(CODEX_USER_IMAGE_LINE)[0].blocks).toEqual([{ kind: 'image' }])
  })

  it('strips the desktop preamble down to the request after the marker', () => {
    expect(parse(CODEX_USER_MARKER_LINE)[0].blocks).toEqual([
      { kind: 'text', text: 'Retry the failed deploy' },
    ])
  })

  it('skips synthetic user envelopes', () => {
    expect(parse(CODEX_USER_ENV_LINE)).toEqual([])
    expect(parse(CODEX_USER_INSTRUCTIONS_LINE)).toEqual([])
    expect(parse(CODEX_USER_PLUGINS_LINE)).toEqual([])
    expect(parse(CODEX_USER_SUBAGENT_LINE)).toEqual([])
  })

  it('maps the turn_aborted user envelope to a system Interrupted marker', () => {
    const [message] = parse(CODEX_USER_ABORT_LINE)
    expect(message.role).toBe('system')
    expect(message.blocks).toEqual([{ kind: 'text', text: 'Interrupted' }])
  })

  it('skips developer-role messages', () => {
    expect(parse(CODEX_DEVELOPER_LINE)).toEqual([])
  })

  it('parses assistant output_text', () => {
    expect(parse(CODEX_ASSISTANT_LINE)[0]).toMatchObject({
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'Version bumped.' }],
    })
  })

  it('maps reasoning summaries to thinking blocks', () => {
    expect(parse(CODEX_REASONING_LINE)[0].blocks).toEqual([
      { kind: 'thinking', text: '**Weighing the version bump**' },
      { kind: 'thinking', text: '**Checking the changelog**' },
    ])
  })

  it('drops encrypted-only reasoning', () => {
    expect(parse(CODEX_REASONING_ENCRYPTED_LINE)).toEqual([])
  })

  it('maps function_call to a tool block with summarized arguments', () => {
    expect(parse(CODEX_FUNCTION_CALL_LINE)[0].blocks).toEqual([
      { kind: 'tool', id: 'call_demo_1', name: 'exec_command', input: 'cat package.json' },
    ])
  })

  it('joins argv-array arguments', () => {
    expect(parse(CODEX_FUNCTION_CALL_SHELL_LINE)[0].blocks).toEqual([
      { kind: 'tool', id: 'call_demo_2', name: 'shell', input: 'bash -lc echo hi' },
    ])
  })

  it('keeps the raw arguments string when its JSON is torn', () => {
    expect(parse(CODEX_FUNCTION_CALL_BAD_ARGS_LINE)[0].blocks).toEqual([
      { kind: 'tool', id: 'call_demo_3', name: 'exec_command', input: '{"cmd":"tr' },
    ])
  })

  it('maps function_call_output to a tool-role result paired by call_id', () => {
    expect(parse(CODEX_FUNCTION_OUTPUT_LINE)).toEqual([{
      uid: `${CODEX_FILE_BASE}:7`,
      role: 'tool',
      blocks: [{ kind: 'toolResult', forId: 'call_demo_1', output: '{\n  "version": "0.0.1"\n}' }],
      ts: CODEX_TS_MS,
    }])
  })

  it('maps custom_tool_call with its raw string input', () => {
    expect(parse(CODEX_CUSTOM_CALL_LINE)[0].blocks).toEqual([
      { kind: 'tool', id: 'call_demo_4', name: 'exec', input: 'const v = require("./package.json").version;\ntext(v);\n' },
    ])
  })

  it('joins custom_tool_call_output block-list output', () => {
    expect(parse(CODEX_CUSTOM_OUTPUT_LINE)[0].blocks).toEqual([
      { kind: 'toolResult', forId: 'call_demo_4', output: 'Script completed\n0.0.1' },
    ])
  })

  it('maps local_shell_call to a shell tool block', () => {
    expect(parse(CODEX_LOCAL_SHELL_LINE)[0].blocks).toEqual([
      { kind: 'tool', id: 'call_demo_5', name: 'shell', input: 'ls -la' },
    ])
  })

  it('maps web_search_call to a web_search tool block', () => {
    expect(parse(CODEX_WEB_SEARCH_LINE)[0].blocks).toEqual([
      { kind: 'tool', name: 'web_search', input: 'semver cheat sheet' },
    ])
  })
})

describe('parseQuestionInput', () => {
  it('rejects non-object input, missing questions, and empty options', () => {
    for (const bad of [null, 'x', [], {}, { questions: [] }, { questions: [{ question: 'q', options: [] }] }]) {
      expect(parseQuestionInput(bad)).toBeNull()
    }
  })

  it('clips over-long question lists and option lists instead of failing', () => {
    const option = { label: 'ok' }
    const question = { question: 'pick', options: Array.from({ length: 10 }, () => option) }
    const parsed = parseQuestionInput({ questions: Array.from({ length: 10 }, () => question) })
    expect(parsed).toHaveLength(5)
    expect(parsed?.[0].options).toHaveLength(6)
  })

  it('caps text fields', () => {
    const parsed = parseQuestionInput({
      questions: [{
        question: 'q'.repeat(1000),
        header: 'h'.repeat(100),
        options: [{ label: 'l'.repeat(500), description: 'd'.repeat(1000) }],
      }],
    })
    expect(parsed?.[0].question.length).toBe(400)
    expect(parsed?.[0].header?.length).toBe(40)
    expect(parsed?.[0].options[0].label.length).toBe(120)
    expect(parsed?.[0].options[0].description?.length).toBe(350)
  })
})
