import type { AgentReasoningEffort, CustomAction, ExecLaunchProfile } from './types'

export const CLAUDE_INTERACTIVE_COMMAND_PREVIEW = 'claude --dangerously-skip-permissions'
export const CLAUDE_PRINT_COMMAND_PREVIEW = 'claude -p --dangerously-skip-permissions'

export const CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW = CLAUDE_INTERACTIVE_COMMAND_PREVIEW

// Blank interactive Claude instances auto-run this slash command on startup so
// new sessions are immediately controllable from the mobile remote.
export const CLAUDE_REMOTE_CONTROL_COMMAND = '/remote-control'

export function getClaudeShellCommandBinary(): string {
  return 'claude'
}

const CODEX_DEFAULT_REASONING_EFFORT: AgentReasoningEffort = 'high'

function getCodexDefaultArgs(reasoningEffort: AgentReasoningEffort = CODEX_DEFAULT_REASONING_EFFORT): string[] {
  return [
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'model_reasoning_summary="detailed"',
    '-c',
    'model_supports_reasoning_summaries=true',
  ]
}

export const CODEX_INTERACTIVE_COMMAND_PREVIEW = ['codex', ...getCodexDefaultArgs()].join(' ')
export const CODEX_PRINT_COMMAND_PREVIEW = ['codex', '-q', ...getCodexDefaultArgs()].join(' ')
export const CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW = CODEX_INTERACTIVE_COMMAND_PREVIEW
export const CODEX_PRINT_SHELL_COMMAND_PREVIEW = CODEX_PRINT_COMMAND_PREVIEW

export function getCodexShellCommandBinary(): string {
  return 'codex'
}

const CURSOR_DEFAULT_ARGS = ['--force', '--model', 'composer-2-fast'] as const

export const CURSOR_INTERACTIVE_COMMAND_PREVIEW = ['agent', ...CURSOR_DEFAULT_ARGS].join(' ')
export const CURSOR_PRINT_COMMAND_PREVIEW = ['agent', '-p', ...CURSOR_DEFAULT_ARGS].join(' ')
export const CURSOR_INTERACTIVE_SHELL_COMMAND_PREVIEW = CURSOR_INTERACTIVE_COMMAND_PREVIEW
export const CURSOR_PRINT_SHELL_COMMAND_PREVIEW = CURSOR_PRINT_COMMAND_PREVIEW

export function getCursorShellCommandBinary(): string {
  return 'agent'
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

function shellToken(value: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : shellQuote(value)
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
    if (action.agentModel?.trim()) parts.push('--model', shellToken(action.agentModel.trim()))
    if (action.agentReasoningEffort) parts.push('--effort', action.agentReasoningEffort)
    parts.push('--dangerously-skip-permissions')
    if (action.command?.trim()) {
      parts.push(shellQuote(action.command))
    } else if (!action.printMode) {
      // Blank interactive Claude instance — auto-run /remote-control on startup.
      parts.push(shellQuote(CLAUDE_REMOTE_CONTROL_COMMAND))
    }
    return parts.join(' ')
  }

  if (actionType === 'codex') {
    const parts = [getCodexShellCommandBinary()]
    if (action.printMode) parts.push('-q')
    if (action.agentModel?.trim()) parts.push('--model', shellToken(action.agentModel.trim()))
    parts.push(...getCodexDefaultArgs(action.agentReasoningEffort ?? CODEX_DEFAULT_REASONING_EFFORT))
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  if (actionType === 'cursor') {
    const parts = [getCursorShellCommandBinary()]
    if (action.printMode) parts.push('-p')
    parts.push(...CURSOR_DEFAULT_ARGS)
    if (action.command) parts.push(shellQuote(action.command))
    return parts.join(' ')
  }

  return action.command || undefined
}
