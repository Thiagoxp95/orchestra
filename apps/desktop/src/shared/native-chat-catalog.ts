// Static model catalog for the chat model picker — the fallback when the
// provider hasn't advertised its live list yet (snapshot.models).
//
// Claude: t3code's apps/server/src/provider/model-manifest.json (MIT), current +
// legacy models, efforts from each model's profile. Dropped from its effort
// lists: `ultrathink` (a prompt-injected keyword, not an SDK effort) and
// `ultracode` (t3's own xhigh + orchestration mode).
// Codex / Cursor: t3code's manifest only carries Claude; their lists come from
// t3code packages/contracts/src/model.ts (default + alias tables) plus the
// codex-cli picker order Orchestra already drives, and Orchestra's own Cursor
// launch default (composer-2-fast).

import type { NativeChatModel, NativeChatProvider } from './native-chat'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_EFFORTS_NO_XHIGH = ['low', 'medium', 'high', 'max']
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']

export const NATIVE_CHAT_CATALOG: Record<NativeChatProvider, NativeChatModel[]> = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', efforts: CLAUDE_EFFORTS },
    { id: 'claude-opus-5', label: 'Claude Opus 5', efforts: CLAUDE_EFFORTS },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: CLAUDE_EFFORTS },
    { id: 'claude-fable-5', label: 'Claude Fable 5', efforts: CLAUDE_EFFORTS },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: CLAUDE_EFFORTS },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', efforts: CLAUDE_EFFORTS },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', efforts: CLAUDE_EFFORTS_NO_XHIGH },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: CLAUDE_EFFORTS_NO_XHIGH },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', efforts: [] },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.4', label: 'GPT-5.4', efforts: CODEX_EFFORTS },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', efforts: CODEX_EFFORTS },
  ],
  cursor: [
    { id: 'auto', label: 'Auto', efforts: [] },
    { id: 'composer-2', label: 'Composer 2', efforts: [] },
    { id: 'composer-2-fast', label: 'Composer 2 Fast', efforts: [] },
    { id: 'composer-1.5', label: 'Composer 1.5', efforts: [] },
  ],
}

export const NATIVE_CHAT_PROVIDER_NAMES: Record<NativeChatProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

/**
 * The picker's list for one provider: the live catalog when the provider sent
 * one (it knows what this account can run), else the static one. A live row
 * whose label is just its id borrows the static label. The model the session
 * is running always appears, even if neither list knows it — otherwise the
 * picker would show no selection at all.
 */
export function nativeChatModels(
  provider: NativeChatProvider,
  live: NativeChatModel[] | undefined,
  current?: string,
): NativeChatModel[] {
  const fallback = NATIVE_CHAT_CATALOG[provider]
  const models = live?.length
    ? live.map((model) => {
        if (model.label && model.label !== model.id) return model
        const known = fallback.find((candidate) => candidate.id === model.id)
        return known ? { ...model, label: known.label } : model
      })
    : fallback
  if (current && !models.some((model) => model.id === current)) {
    const known = fallback.find((candidate) => candidate.id === current)
    return [known ?? { id: current, label: current, efforts: [] }, ...models]
  }
  return models
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

export function nativeChatEffortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
