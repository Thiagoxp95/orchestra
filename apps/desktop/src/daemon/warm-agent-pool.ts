import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
} from '../shared/action-utils'

export type WarmAgentKind = 'claude' | 'codex'

export const DEFAULT_WARM_AGENT_POOL_SIZE = 1
export const WARM_AGENT_IDLE_TTL_MS = 2 * 60_000

export function isWarmAgentPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCHESTRA_EXPERIMENTAL_WARM_AGENTS === '1'
}

export function buildWarmAgentPoolKey(cwd: string, kind: WarmAgentKind): string {
  return `${kind}:${cwd}`
}

export function getWarmAgentKindForCommand(initialCommand?: string): WarmAgentKind | null {
  if (!initialCommand) return null
  if (
    initialCommand === CLAUDE_INTERACTIVE_COMMAND_PREVIEW
    || initialCommand === CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW
  ) {
    return 'claude'
  }
  if (
    initialCommand === CODEX_INTERACTIVE_COMMAND_PREVIEW
    || initialCommand === CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW
  ) {
    return 'codex'
  }
  return null
}
