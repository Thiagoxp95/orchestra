import type { CustomAction } from './types'

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

export function getCodexShellCommandBinary(): string {
  return CODEX_WRAPPER_BIN_RESOLUTION
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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
