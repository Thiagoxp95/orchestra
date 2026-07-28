// Synthesized codex rollout lines for the agent-message-model tests.
//
// Shapes mirror real ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl records
// (verified against live rollouts on this machine, 2026-07): `response_item`
// lines carry the canonical conversation; `event_msg` lines duplicate the same
// user/agent text; session_meta/turn_context/world_state are bookkeeping.
// Current codex writes `custom_tool_call` (raw string input) for most tools
// and `function_call` (JSON-string arguments) for the rest — both appear here.
// Every string is invented — no real conversation content is committed.

export const CODEX_FILE_BASE = 'rollout-2026-07-01T09-00-00-0e0e0e0e-0000-4000-8000-000000000002'
export const CODEX_TS = '2026-07-01T09:00:05.000Z'
export const CODEX_TS_MS = Date.parse(CODEX_TS)

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: CODEX_TS, type, payload })
}

function responseItem(payload: Record<string, unknown>): string {
  return line('response_item', payload)
}

// --- Non-conversation record types: all must parse to []. ---

export const CODEX_SESSION_META_LINE = line('session_meta', {
  session_id: '0e0e0e0e-0000-4000-8000-000000000002',
  cwd: '/tmp/demo-project',
  originator: 'codex_cli',
})
export const CODEX_TURN_CONTEXT_LINE = line('turn_context', {
  turn_id: 'turn-1',
  cwd: '/tmp/demo-project',
})
export const CODEX_WORLD_STATE_LINE = line('world_state', { full: true, state: {} })

/** event_msg copies of conversation text — duplicates of response_item, skipped. */
export const CODEX_EVENT_USER_LINE = line('event_msg', {
  type: 'user_message',
  message: 'Bump the parser version',
})
export const CODEX_EVENT_AGENT_LINE = line('event_msg', {
  type: 'agent_message',
  message: 'Version bumped.',
})

// --- Conversation response_items. ---

export const CODEX_USER_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Bump the parser version' }],
})

/** Attachment-only turn: file-list preamble plus the pasted image itself. */
export const CODEX_USER_IMAGE_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [
    { type: 'input_text', text: '# Files mentioned by the user:\n\n## photo.jpg: /tmp/attachments/photo.jpg' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,aGk=' },
  ],
})

/** Codex Desktop preamble + marker — only the request after the marker shows. */
export const CODEX_USER_MARKER_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [
    { type: 'input_text', text: '# Attached files\n\n(listing)\n\n## My request for Codex:\nRetry the failed deploy' },
  ],
})

export const CODEX_USER_ENV_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/tmp/demo-project</cwd>\n</environment_context>' }],
})
export const CODEX_USER_INSTRUCTIONS_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<user_instructions>\nAlways demo.\n</user_instructions>' }],
})
export const CODEX_USER_PLUGINS_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<recommended_plugins>\nHere is a list of plugins…\n</recommended_plugins>' }],
})
export const CODEX_USER_SUBAGENT_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<subagent_notification>\n{"status":"DONE"}\n</subagent_notification>' }],
})

/** Codex records an interrupt as a synthetic turn_aborted user message. */
export const CODEX_USER_ABORT_LINE = responseItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }],
})

/** role developer: permissions/apps plumbing, never conversation. */
export const CODEX_DEVELOPER_LINE = responseItem({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: '<permissions instructions>\nsandbox demo\n</permissions instructions>' }],
})

export const CODEX_ASSISTANT_LINE = responseItem({
  type: 'message',
  id: 'msg_demo_1',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Version bumped.' }],
  phase: 'commentary',
})

export const CODEX_REASONING_LINE = responseItem({
  type: 'reasoning',
  id: 'rs_demo_1',
  summary: [
    { type: 'summary_text', text: '**Weighing the version bump**' },
    { type: 'summary_text', text: '**Checking the changelog**' },
  ],
  encrypted_content: 'AAAA',
})

/** Encrypted-only reasoning: nothing readable, parses to []. */
export const CODEX_REASONING_ENCRYPTED_LINE = responseItem({
  type: 'reasoning',
  id: 'rs_demo_2',
  summary: [],
  content: [],
  encrypted_content: 'AAAA',
})

export const CODEX_FUNCTION_CALL_LINE = responseItem({
  type: 'function_call',
  name: 'exec_command',
  arguments: '{"cmd":"cat package.json","workdir":"/tmp/demo-project","max_output_tokens":2000}',
  call_id: 'call_demo_1',
})

/** shell-style argv arguments. */
export const CODEX_FUNCTION_CALL_SHELL_LINE = responseItem({
  type: 'function_call',
  name: 'shell',
  arguments: '{"command":["bash","-lc","echo hi"],"workdir":"/tmp/demo-project"}',
  call_id: 'call_demo_2',
})

/** Torn/invalid arguments JSON must still render something identifying. */
export const CODEX_FUNCTION_CALL_BAD_ARGS_LINE = responseItem({
  type: 'function_call',
  name: 'exec_command',
  arguments: '{"cmd":"tr',
  call_id: 'call_demo_3',
})

export const CODEX_FUNCTION_OUTPUT_LINE = responseItem({
  type: 'function_call_output',
  call_id: 'call_demo_1',
  output: '{\n  "version": "0.0.1"\n}',
})

/** custom_tool_call carries the raw input string (here: JS for codex `exec`). */
export const CODEX_CUSTOM_CALL_LINE = responseItem({
  type: 'custom_tool_call',
  id: 'ctc_demo_1',
  status: 'completed',
  call_id: 'call_demo_4',
  name: 'exec',
  input: 'const v = require("./package.json").version;\ntext(v);\n',
})

/** custom_tool_call_output's output is a block list, not a string. */
export const CODEX_CUSTOM_OUTPUT_LINE = responseItem({
  type: 'custom_tool_call_output',
  call_id: 'call_demo_4',
  output: [
    { type: 'input_text', text: 'Script completed' },
    { type: 'input_text', text: '0.0.1' },
  ],
})

export const CODEX_LOCAL_SHELL_LINE = responseItem({
  type: 'local_shell_call',
  call_id: 'call_demo_5',
  status: 'completed',
  action: { type: 'exec', command: ['ls', '-la'], timeout_ms: 1000 },
})

export const CODEX_WEB_SEARCH_LINE = responseItem({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query: 'semver cheat sheet' },
})
