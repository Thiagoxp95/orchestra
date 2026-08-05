// ── Slash-command autocomplete ───────────────────────────────────────────────
// A static snapshot of claude-code's built-in slash commands (2.1.x). The
// desktop doesn't mirror the CLI's live command list (custom skills, plugins),
// so this can only offer the built-ins — an entry the running CLI doesn't
// know is harmless (the TUI answers "unknown command"), and a command the
// user types that isn't listed here still sends fine; the box just hides.

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
 * Ranked autocomplete matches for the composer draft, or [] when the draft
 * isn't a slash command under construction. A bare "/" lists the catalog in
 * its curated order (most-reached-for first).
 */
export function matchSlashCommands(draft: string, limit = 8): SlashCommand[] {
  const m = TYPING_A_COMMAND.exec(draft.trim())
  if (!m) return []
  const query = m[1].toLowerCase()
  if (!query) return CLAUDE_SLASH_COMMANDS.slice(0, limit)
  return CLAUDE_SLASH_COMMANDS.map((cmd, i) => ({ cmd, i, score: fuzzyScore(query, cmd.name) }))
    .filter((r): r is { cmd: SlashCommand; i: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.cmd)
}
