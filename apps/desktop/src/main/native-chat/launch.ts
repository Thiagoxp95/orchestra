import { parseLaunchSelection } from '../../shared/launch-selection'
import type { NativeChatProvider } from '../../shared/native-chat'
/** Only intercept known interactive launches; scripts and print-mode actions keep their semantics. */
export function nativeLaunch(initialCommand?: string): { provider: NativeChatProvider; conversationId?: string; settings: ReturnType<typeof parseLaunchSelection> } | null {
  const command = initialCommand?.trim()
  if (!command) return null
  const match = command.match(/^(claude|codex|agent)(?:\s|$)/)
  if (!match || /(?:^|\s)(?:-p|--print|-q|exec|review|app-server)(?:\s|$)|[;&|\n]/.test(command)) return null
  const provider: NativeChatProvider = match[1] === 'agent' ? 'cursor' : match[1] as NativeChatProvider
  const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []
  const plain = (token: string) => token.replace(/["']/g, '')
  for (let index = 1; index < tokens.length; index++) {
    const token = plain(tokens[index])
    if (['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', ...(provider === 'cursor' ? ['--force', '-f'] : [])].includes(token)) continue
    if (/^--(?:model|effort)=.+/.test(token)) continue
    if (['--model', '-m', '--effort', '--resume', '-r'].includes(token) || (provider === 'codex' && index === 1 && token === 'resume')) {
      const value = tokens[++index]
      if (!value || plain(value).startsWith('-')) return null
      continue
    }
    if (provider === 'codex' && token === '-c') {
      const value = tokens[++index]
      if (!value || !/^(?:model_reasoning_effort|model_reasoning_summary|model_supports_reasoning_summaries)=/.test(plain(value))) return null
      continue
    }
    return null
  }
  const resume = provider === 'claude'
    ? command.match(/(?:--resume|-r)\s+['"]?([a-f\d-]{36})['"]?(?:\s|$)/i)
    : command.match(/^codex\s+resume\s+['"]?([a-f\d-]{36})['"]?(?:\s|$)/i)
  if (/(?:--resume|--continue|\sresume\b|\s-r\b|\s-c\s*$)/.test(command) && !resume) return null
  return { provider, ...(resume ? { conversationId: resume[1] } : {}), settings: parseLaunchSelection(command) }
}
