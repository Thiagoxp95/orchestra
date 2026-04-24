import type { CustomAction, ExecLaunchProfile } from './types'

export const CLAUDE_INTERACTIVE_COMMAND_PREVIEW = 'claude --dangerously-skip-permissions'
export const CLAUDE_PRINT_COMMAND_PREVIEW = 'claude -p --dangerously-skip-permissions'

export const CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW = CLAUDE_INTERACTIVE_COMMAND_PREVIEW

export function getClaudeShellCommandBinary(): string {
  return 'claude'
}

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
export const CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW = CODEX_INTERACTIVE_COMMAND_PREVIEW
export const CODEX_PRINT_SHELL_COMMAND_PREVIEW = CODEX_PRINT_COMMAND_PREVIEW

export function getCodexShellCommandBinary(): string {
  return 'codex'
}

export function isCodexInteractiveInitialCommand(initialCommand?: string): boolean {
  if (!initialCommand) return false

  const trimmed = initialCommand.trim()
  if (trimmed === 'codex') return true
  if (trimmed.startsWith('codex ')) {
    const remainder = trimmed.slice('codex '.length)
    return !(
      remainder.startsWith('-q')
      || remainder.startsWith('exec')
      || remainder.startsWith('review')
      || remainder.startsWith('app-server')
      || remainder.startsWith('resume')
    )
  }

  return (
    initialCommand === CODEX_INTERACTIVE_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CODEX_INTERACTIVE_COMMAND_PREVIEW} `)
    || initialCommand === CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW
    || initialCommand.startsWith(`${CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW} `)
  )
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
    const parts = [getClaudeShellCommandBinary()]
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
