// ── Slash-command autocomplete ───────────────────────────────────────────────
// Two sources, merged: a static snapshot of the running CLI's built-in slash
// commands (claude-code 2.1.x / codex-cli 0.146.x), plus the user's OWN commands
// — skills, ~/.claude/commands, ~/.codex/prompts, plugin commands, and whatever
// the repo checks in — which the main process scans straight off local disk and
// hands over IPC (the phone gets the same catalog through remoteState instead).
// An entry the running CLI doesn't know is harmless (the TUI answers "unknown
// command"), and a command the user types that isn't listed still sends fine;
// the box just hides.

export type SlashCommand = { name: string; description: string }

export const CLAUDE_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compress the conversation to free context' },
  { name: 'clear', description: 'Start a fresh conversation' },
  { name: 'context', description: 'Show what is using the context window' },
  { name: 'model', description: 'Switch the model' },
  { name: 'effort', description: 'Set the reasoning effort' },
  { name: 'resume', description: 'Resume a past session' },
  { name: 'rewind', description: 'Rewind conversation or code to a checkpoint' },
  { name: 'plan', description: 'Enter plan mode' },
  { name: 'fast', description: 'Toggle fast mode' },
  { name: 'usage', description: 'Show rate-limit usage' },
  { name: 'cost', description: 'Session token usage and cost' },
  { name: 'status', description: 'Version, model, and account status' },
  { name: 'todos', description: 'List the current todos' },
  { name: 'workflows', description: 'Watch running workflows' },
  { name: 'export', description: 'Export the conversation' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'security-review', description: 'Security review of the changes' },
  { name: 'pr-comments', description: 'View pull-request comments' },
  { name: 'init', description: 'Generate a CLAUDE.md for this repo' },
  { name: 'memory', description: 'Edit memory files' },
  { name: 'permissions', description: 'View or update tool permissions' },
  { name: 'agents', description: 'Manage subagents' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'hooks', description: 'Manage hooks' },
  { name: 'config', description: 'Open settings' },
  { name: 'output-style', description: 'Set the output style' },
  { name: 'statusline', description: 'Configure the status line' },
  { name: 'add-dir', description: 'Add a working directory' },
  { name: 'bashes', description: 'List background shells' },
  { name: 'ide', description: 'Connect to an IDE' },
  { name: 'vim', description: 'Toggle vim editing mode' },
  { name: 'terminal-setup', description: 'Configure Shift+Enter newlines' },
  { name: 'install-github-app', description: 'Set up Claude for GitHub PRs' },
  { name: 'release-notes', description: 'View release notes' },
  { name: 'doctor', description: 'Diagnose installation issues' },
  { name: 'bug', description: 'Report a bug to Anthropic' },
  { name: 'help', description: 'List available commands' },
  { name: 'login', description: 'Switch Anthropic account' },
  { name: 'logout', description: 'Sign out' },
  { name: 'exit', description: 'Quit Claude Code (ends the session)' },
]

/**
 * The same snapshot for codex (codex-cli 0.146.x), read off the shipped binary's
 * own command table rather than written from memory. Codex answers to a
 * different set than claude — `/permissions` not `/config`, `/new` not `/clear`,
 * no `/effort` (reasoning effort lives inside `/model`) — so a session running
 * codex gets this list instead, never the two spliced together.
 *
 * Ordered most-reached-for first, like the claude list: a bare "/" shows the
 * head of this array, so the ordering is the whole UX of an empty query.
 * Debug-only entries (`/test-approval`, `/debug-m-*`) are deliberately omitted.
 */
export const CODEX_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'model', description: 'Choose what model and reasoning effort to use' },
  { name: 'compact', description: 'Summarize conversation to prevent hitting the context limit' },
  { name: 'new', description: 'Start a new chat during a conversation' },
  { name: 'clear', description: 'Clear the terminal and start a new chat' },
  { name: 'review', description: 'Review my current changes and find issues' },
  { name: 'plan', description: 'Switch to Plan mode' },
  { name: 'status', description: 'Show current session configuration and token usage' },
  { name: 'usage', description: 'View account usage or use a usage limit reset' },
  { name: 'diff', description: 'Show git diff (including untracked files)' },
  { name: 'mention', description: 'Mention a file' },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for Codex' },
  { name: 'permissions', description: 'Choose what Codex is allowed to do' },
  { name: 'skills', description: 'Use skills to improve how Codex performs specific tasks' },
  { name: 'memory', description: 'Configure memory use and generation' },
  { name: 'goal', description: 'Set or view the goal for a long-running task' },
  { name: 'resume', description: 'Resume a saved chat' },
  { name: 'fork', description: 'Fork the current chat' },
  { name: 'rename', description: 'Rename the current thread' },
  { name: 'archive', description: 'Archive this session and exit' },
  { name: 'delete', description: 'Permanently delete this session and exit' },
  { name: 'side', description: 'Start a side conversation in an ephemeral fork' },
  { name: 'btw', description: 'Start a side conversation in an ephemeral fork' },
  { name: 'hooks', description: 'View and manage lifecycle hooks' },
  { name: 'mcp', description: 'List configured MCP tools' },
  { name: 'apps', description: 'Manage apps' },
  { name: 'plugins', description: 'Browse plugins' },
  { name: 'experimental', description: 'Toggle experimental features' },
  { name: 'personality', description: 'Choose a communication style for Codex' },
  { name: 'theme', description: 'Choose a syntax highlighting theme' },
  { name: 'statusline', description: 'Configure which items appear in the status line' },
  { name: 'title', description: 'Configure which items appear in the terminal title' },
  { name: 'keys', description: 'Remap TUI shortcuts' },
  { name: 'vim', description: 'Toggle Vim mode for the composer' },
  { name: 'pets', description: 'Choose or hide the terminal pet' },
  { name: 'ide', description: 'Include context from your IDE' },
  { name: 'import', description: 'Import setup, this project, and recent chats from Claude Code' },
  { name: 'app', description: 'Continue this session in the Desktop app' },
  { name: 'agent', description: 'Switch the active agent thread' },
  { name: 'ps', description: 'List background terminals' },
  { name: 'stop', description: 'Stop all background terminals' },
  { name: 'rollout', description: 'Print the rollout file path' },
  { name: 'raw', description: 'Toggle raw scrollback mode for copy-friendly selection' },
  { name: 'sandbox-add-read-dir', description: 'Let the sandbox read a directory' },
  { name: 'setup-default-sandbox', description: 'Set up the elevated agent sandbox' },
  { name: 'debug-config', description: 'Show config layers and requirement sources' },
  { name: 'feedback', description: 'Send logs to maintainers' },
  { name: 'logout', description: 'Log out of Codex' },
  { name: 'quit', description: 'Exit Codex' },
  { name: 'exit', description: 'Exit Codex' },
]

/** Which CLI's built-ins to autocomplete from. An agent we don't know gets none
 *  rather than claude's by default — offering the wrong CLI's commands is worse
 *  than offering nothing. */
export function builtInsFor(agent: string | undefined): SlashCommand[] {
  if (agent === 'claude') return CLAUDE_SLASH_COMMANDS
  if (agent === 'codex') return CODEX_SLASH_COMMANDS
  return []
}

/** The draft is a command being typed: "/" plus name characters, no space yet.
 *  Once an argument starts ("/model op…") the box stays out of the way. */
const TYPING_A_COMMAND = /^\/([a-z0-9:_-]*)$/i

/**
 * Subsequence match with a deterministic score. Contiguous runs and
 * word-starts (after a hyphen) score up, gaps score down, and a straight
 * prefix outranks any scattered match of the same query.
 */
function fuzzyScore(query: string, name: string): number | null {
  let score = name.startsWith(query) ? 5 : 0
  let from = 0
  let prevHit = -2
  for (const c of query) {
    const at = name.indexOf(c, from)
    if (at === -1) return null
    if (at === prevHit + 1) score += 3
    if (at === 0 || name[at - 1] === '-') score += 2
    score -= at - from
    prevHit = at
    from = at + 1
  }
  return score
}

/**
 * The built-ins followed by the desktop-mirrored commands, deduped by name.
 * Built-ins keep the head of the list because a bare "/" shows the catalog in
 * order, and they are what a blank composer most often wants; the user's own
 * commands are found by typing (fuzzy) or by scrolling the box.
 */
export function mergeSlashCommands(
  mirrored: SlashCommand[] | undefined,
  builtIns: SlashCommand[] = CLAUDE_SLASH_COMMANDS,
): SlashCommand[] {
  if (!mirrored?.length) return builtIns
  const seen = new Set(builtIns.map((c) => c.name))
  const extra: SlashCommand[] = []
  for (const cmd of mirrored) {
    if (!cmd?.name || seen.has(cmd.name)) continue
    seen.add(cmd.name)
    extra.push({ name: cmd.name, description: cmd.description ?? '' })
  }
  return [...builtIns, ...extra]
}

/**
 * Ranked autocomplete matches for the composer draft, or [] when the draft
 * isn't a slash command under construction. A bare "/" lists the catalog in
 * its curated order (most-reached-for first).
 */
export function matchSlashCommands(
  draft: string,
  limit = 8,
  catalog: SlashCommand[] = CLAUDE_SLASH_COMMANDS,
): SlashCommand[] {
  const m = TYPING_A_COMMAND.exec(draft.trim())
  if (!m) return []
  const query = m[1].toLowerCase()
  if (!query) return catalog.slice(0, limit)
  return catalog.map((cmd, i) => ({ cmd, i, score: fuzzyScore(query, cmd.name) }))
    .filter((r): r is { cmd: SlashCommand; i: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.cmd)
}
