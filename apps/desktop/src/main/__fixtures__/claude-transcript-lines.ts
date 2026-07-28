// Synthesized Claude Code transcript lines for the agent-message-model tests.
//
// Field sets and content shapes mirror real records written by claude-code 2.x
// under ~/.claude/projects/<slug>/<sessionId>.jsonl (verified against live
// transcripts on this machine, 2026-07): user/assistant records carry the
// conversation in message.content; tool loops come back as user records whose
// content is entirely tool_result blocks; slash commands, hook stdout, and
// interrupts arrive as synthetic user text. Every string here is invented —
// no real conversation content is committed.

const BASE = {
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: '/tmp/demo-project',
  sessionId: 'f1e2d3c4-0000-4000-8000-000000000001',
  version: '2.1.100',
  gitBranch: 'main',
}

export const CLAUDE_TS = '2026-07-01T10:00:00.000Z'
export const CLAUDE_TS_MS = Date.parse(CLAUDE_TS)

function line(record: Record<string, unknown>): string {
  return JSON.stringify({ ...BASE, timestamp: CLAUDE_TS, ...record })
}

/** Plain typed prompt with string content. */
export const CLAUDE_USER_STRING_LINE = line({
  type: 'user',
  uuid: 'uu-user-1',
  message: { role: 'user', content: 'Rename the widget factory' },
})

/** Prompt as content blocks: text plus a pasted image. */
export const CLAUDE_USER_BLOCKS_LINE = line({
  type: 'user',
  uuid: 'uu-user-2',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: 'Look at this screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ],
  },
})

/** Full assistant turn: thinking + prose + a Bash tool_use. */
export const CLAUDE_ASSISTANT_LINE = line({
  type: 'assistant',
  uuid: 'uu-asst-1',
  requestId: 'req_1',
  message: {
    role: 'assistant',
    model: 'claude-test-1',
    content: [
      { type: 'thinking', thinking: 'The factory name is stale.', signature: 'sig==' },
      { type: 'text', text: 'Renaming it now.' },
      {
        type: 'tool_use',
        id: 'toolu_001',
        name: 'Bash',
        input: { command: 'git grep -l WidgetFactory', description: 'Find usages' },
      },
    ],
  },
})

/** Assistant record whose only thinking block is empty (signature-only). */
export const CLAUDE_ASSISTANT_EMPTY_THINKING_LINE = line({
  type: 'assistant',
  uuid: 'uu-asst-2',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '', signature: 'sig==' }],
  },
})

/** Tool loop reply: user record, content entirely tool_result (string body). */
export const CLAUDE_TOOL_RESULT_STRING_LINE = line({
  type: 'user',
  uuid: 'uu-tool-1',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_001', content: 'src/factory.ts', is_error: false },
    ],
  },
  toolUseResult: 'src/factory.ts',
})

export const CLAUDE_TOOL_RESULT_ERROR_LINE = line({
  type: 'user',
  uuid: 'uu-tool-2',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_002', content: 'command not found: frob', is_error: true },
    ],
  },
})

/** Result body as a block list: text plus an embedded screenshot. */
export const CLAUDE_TOOL_RESULT_RICH_LINE = line({
  type: 'user',
  uuid: 'uu-tool-3',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_003',
        content: [
          { type: 'text', text: 'Screenshot captured' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    ],
  },
})

/** isMeta + entirely tool_result — the one meta shape that must NOT be skipped. */
export const CLAUDE_META_TOOL_RESULT_LINE = line({
  type: 'user',
  uuid: 'uu-tool-4',
  isMeta: true,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_004', content: 'ok' }],
  },
})

/** isMeta annotation (image-paste note) — harness bookkeeping, skipped. */
export const CLAUDE_META_NOTE_LINE = line({
  type: 'user',
  uuid: 'uu-meta-1',
  isMeta: true,
  message: { role: 'user', content: '[Image: original 800x600, displayed at 400x300]' },
})

/** Sub-agent turn — a different conversation, skipped. */
export const CLAUDE_SIDECHAIN_LINE = line({
  type: 'user',
  uuid: 'uu-side-1',
  isSidechain: true,
  message: { role: 'user', content: 'sidechain task prompt' },
})

/** Post-compaction re-narration of history the mirror already showed. */
export const CLAUDE_COMPACT_SUMMARY_LINE = line({
  type: 'user',
  uuid: 'uu-compact-1',
  isCompactSummary: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
})

/** Slash command envelope, with args. */
export const CLAUDE_COMMAND_LINE = line({
  type: 'user',
  uuid: 'uu-cmd-1',
  message: {
    role: 'user',
    content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the parser</command-args>',
  },
})

/** Slash command envelope, no args. */
export const CLAUDE_COMMAND_NO_ARGS_LINE = line({
  type: 'user',
  uuid: 'uu-cmd-2',
  message: {
    role: 'user',
    content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
  },
})

export const CLAUDE_STDOUT_LINE = line({
  type: 'user',
  uuid: 'uu-stdout-1',
  message: { role: 'user', content: '<local-command-stdout>Set model to Test 1</local-command-stdout>' },
})

export const CLAUDE_SYSTEM_REMINDER_LINE = line({
  type: 'user',
  uuid: 'uu-rem-1',
  message: { role: 'user', content: '<system-reminder>Contents of a settings file…</system-reminder>' },
})

/** Hook-injected reminder block alongside the real prompt — only the reminder drops. */
export const CLAUDE_MIXED_REMINDER_LINE = line({
  type: 'user',
  uuid: 'uu-rem-2',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>Injected context…</system-reminder>' },
      { type: 'text', text: 'Now fix the flaky test' },
    ],
  },
})

export const CLAUDE_HOOK_LINE = line({
  type: 'user',
  uuid: 'uu-hook-1',
  message: { role: 'user', content: '<user-prompt-submit-hook>hook output</user-prompt-submit-hook>' },
})

export const CLAUDE_CAVEAT_LINE = line({
  type: 'user',
  uuid: 'uu-caveat-1',
  message: { role: 'user', content: 'Caveat: The messages below were generated by the user while running local commands.' },
})

export const CLAUDE_INTERRUPT_LINE = line({
  type: 'user',
  uuid: 'uu-int-1',
  message: { role: 'user', content: '[Request interrupted by user]' },
})

/** The tool-use variant arrives as a text block, not a string body. */
export const CLAUDE_INTERRUPT_TOOL_LINE = line({
  type: 'user',
  uuid: 'uu-int-2',
  message: {
    role: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
  },
})

/** Conversation record missing its uuid — no stable identity, unusable. */
export const CLAUDE_NO_UUID_LINE = line({
  type: 'user',
  message: { role: 'user', content: 'orphan record' },
})

/**
 * Every non-conversation record type observed in real transcripts. All must
 * parse to [] — the chat view shows the dialogue, not the harness diary.
 */
export const CLAUDE_NON_CONVERSATION_LINES: string[] = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Demo session', sessionId: BASE.sessionId }),
  JSON.stringify({ type: 'summary', summary: 'Demo summary', leafUuid: 'uu-leaf-1' }),
  JSON.stringify({ type: 'progress', uuid: 'uu-prog-1', data: {} }),
  line({ type: 'system', uuid: 'uu-sys-1', subtype: 'stop', isMeta: true }),
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId: BASE.sessionId }),
  JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: BASE.sessionId }),
  JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {}, isSnapshotUpdate: false }),
  line({ type: 'attachment', uuid: 'uu-att-1', attachment: { type: 'demo' } }),
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'queued text', sessionId: BASE.sessionId, timestamp: CLAUDE_TS }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', leafUuid: 'uu-leaf-2', sessionId: BASE.sessionId }),
]

/** AskUserQuestion tool_use: a two-question form (single + multi select). */
export const CLAUDE_ASK_QUESTION_LINE = line({
  type: 'assistant',
  uuid: 'uu-ask-1',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Quick check before I refactor:' },
      {
        type: 'tool_use',
        id: 'toolu_ask1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which module should own the parser?',
              header: 'Owner',
              multiSelect: false,
              options: [
                { label: 'core', description: 'Keep it near the model types' },
                { label: 'cli', description: 'Keep it near the consumers' },
              ],
            },
            {
              question: 'Which targets should I test?',
              header: 'Targets',
              multiSelect: true,
              options: [
                { label: 'node', description: 'The daemon runtime' },
                { label: 'browser' },
              ],
            },
          ],
        },
      },
    ],
  },
})

/** AskUserQuestion tool_use whose input is malformed (option without label). */
export const CLAUDE_ASK_MALFORMED_LINE = line({
  type: 'assistant',
  uuid: 'uu-ask-2',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_ask2',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Broken?', options: [{ description: 'no label' }] }] },
      },
    ],
  },
})

/** The answered side: tool_result content plus entry-level toolUseResult.answers. */
export const CLAUDE_ASK_ANSWER_LINE = line({
  type: 'user',
  uuid: 'uu-ask-ans-1',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_ask1',
        content: 'Your questions have been answered: "Which module should own the parser?"="core", "Which targets should I test?"="node, browser". You can now continue with these answers in mind.',
      },
    ],
  },
  toolUseResult: {
    questions: [],
    answers: {
      'Which module should own the parser?': 'core',
      'Which targets should I test?': 'node, browser',
    },
    annotations: {},
  },
})

/** The dismissed side: rejection tool_result, no structured answers. */
export const CLAUDE_ASK_REJECT_LINE = line({
  type: 'user',
  uuid: 'uu-ask-rej-1',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_ask1',
        content: "The user doesn't want to proceed with this tool use.",
        is_error: true,
      },
    ],
  },
  toolUseResult: 'Error: rejected',
})
