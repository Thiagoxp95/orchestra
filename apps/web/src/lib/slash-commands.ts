// ── Slash-command autocomplete ───────────────────────────────────────────────
// Two sources, merged: a static snapshot of claude-code's built-in slash
// commands (2.1.x), plus the user's OWN commands — skills, ~/.claude/commands,
// plugin commands, and whatever the repo checks in — which the desktop scans off
// disk and mirrors through remoteState.slashCommands. An entry the running CLI
// doesn't know is harmless (the TUI answers "unknown command"), and a command
// the user types that isn't listed still sends fine; the box just hides.

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
export function mergeSlashCommands(mirrored: SlashCommand[] | undefined): SlashCommand[] {
  if (!mirrored?.length) return CLAUDE_SLASH_COMMANDS
  const seen = new Set(CLAUDE_SLASH_COMMANDS.map((c) => c.name))
  const extra: SlashCommand[] = []
  for (const cmd of mirrored) {
    if (!cmd?.name || seen.has(cmd.name)) continue
    seen.add(cmd.name)
    extra.push({ name: cmd.name, description: cmd.description ?? '' })
  }
  return [...CLAUDE_SLASH_COMMANDS, ...extra]
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
