import type { CustomAction, ExecLaunchProfile } from './types'

export const CLAUDE_INTERACTIVE_COMMAND_PREVIEW = 'claude --dangerously-skip-permissions'
export const CLAUDE_PRINT_COMMAND_PREVIEW = 'claude -p --dangerously-skip-permissions'

const CODEX_DEFAULT_ARGS = [
  '-c',
  'model_reasoning_effort="high"',
  '--dangerously-bypass-approvals-and-sandbox',
  '-c',
  'model_reasoning_summary="detailed"',
  '-c',
  'model_supports_reasoning_summaries=true',
] as const

export const CODEX_INTERACTIVE_COMMAND_PREVIEW = ['codex', ...CODEX_DEFAULT_ARGS].join(' ')
export const CODEX_PRINT_COMMAND_PREVIEW = ['codex', '-q', ...CODEX_DEFAULT_ARGS].join(' ')
const CODEX_WRAPPER_BIN_RESOLUTION = [
  'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"',
  '[ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"',
  '"$ORCHESTRA_CODEX_BIN"',
].join('; ')
export const CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW = [CODEX_WRAPPER_BIN_RESOLUTION, ...CODEX_DEFAULT_ARGS].join(' ')
export const CODEX_PRINT_SHELL_COMMAND_PREVIEW = [CODEX_WRAPPER_BIN_RESOLUTION, '-q', ...CODEX_DEFAULT_ARGS].join(' ')

export function getCodexShellCommandBinary(): string {
  return CODEX_WRAPPER_BIN_RESOLUTION
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build an exec launch profile for agent sessions.
 * Currently returns undefined — Claude/Codex are launched via shell commands
 * so the command is visible in the terminal.
 */
export function buildAgentLaunchProfile(_action: CustomAction): ExecLaunchProfile | undefined {
  return undefined
}

export function buildActionCommand(action: CustomAction): string | undefined {
  const actionType = action.actionType ?? 'cli'

  if (actionType === 'claude') {
    const parts = ['claude']
    if (action.printMode) parts.push('-p')
    parts.push('--dangerously-skip-permissions')
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  if (actionType === 'codex') {
    const parts = [getCodexShellCommandBinary()]
    if (action.printMode) parts.push('-q')
    parts.push(...CODEX_DEFAULT_ARGS)
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  return action.command || undefined
}
