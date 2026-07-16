import type { AgentReasoningEffort, CustomAction, ExecLaunchProfile } from './types'

export const CLAUDE_INTERACTIVE_COMMAND_PREVIEW = 'claude --dangerously-skip-permissions'
export const CLAUDE_PRINT_COMMAND_PREVIEW = 'claude -p --dangerously-skip-permissions'

export const CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW = CLAUDE_INTERACTIVE_COMMAND_PREVIEW

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

export function buildActionCommand(
  action: CustomAction,
  opts?: { automationStream?: boolean },
): string | undefined {
  const actionType = action.actionType ?? 'cli'

  if (actionType === 'claude') {
    const parts = [getClaudeShellCommandBinary()]
    if (action.printMode) parts.push('-p')
    // Text print mode emits nothing until the run completes, so the automation
    // engines' idle timeout would kill any run longer than the idle window.
    // stream-json emits events continuously — that stream is the liveness signal.
    if (action.printMode && opts?.automationStream) {
      parts.push('--output-format', 'stream-json', '--verbose')
    }
    if (action.agentModel?.trim()) parts.push('--model', shellToken(action.agentModel.trim()))
    if (action.agentReasoningEffort) parts.push('--effort', action.agentReasoningEffort)
    parts.push('--dangerously-skip-permissions')
    if (action.command?.trim()) {
      parts.push(shellQuote(action.command))
    }
    // Blank interactive Claude sessions launch bare — Orchestra's own mobile
    // remote attaches via the daemon PTY tap, so there's no need to auto-run
    // Claude's /remote-control (which would spawn a redundant claude.ai session).
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

/**
 * Command for unattended automation runs (both the in-app scheduler and the
 * daemon engine). Agents are forced into print mode, and Claude additionally
 * streams JSON events so the engines' idle timeout measures real hangs rather
 * than killing long silent print-mode runs. Engines render the event stream
 * back to readable text via createClaudeStreamRenderer.
 */
export function buildAutomationCommand(action: CustomAction): string | undefined {
  const forced = (action.actionType === 'claude' || action.actionType === 'codex')
    ? { ...action, printMode: true }
    : action
  return buildActionCommand(forced, { automationStream: true })
}
