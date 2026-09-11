import type {
  NativeChatCommand,
  NativeChatModel,
  NativeChatProvider,
  NativeChatSnapshot,
} from './native-chat'

export type NativeDraftResult = { command: NativeChatCommand } | { error: string }
export type NativeAnswerDraft = Record<string, { selected: string[]; freeText: string }>
export type NativePickerOption = { value: string; label: string; hint?: string }
export type NativePickerCatalog = {
  models: NativePickerOption[]
  efforts: NativePickerOption[]
}

/** Enrollment can be cancelled before its first native snapshot is published. */
export function shouldUseNativeInterrupt(
  nativeActive: boolean,
  nativeStartBusy: boolean,
): boolean {
  return nativeActive || nativeStartBusy
}

function effortLabel(value: string): string {
  if (value.toLowerCase() === 'xhigh') return 'Extra high'
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function protocolEffort(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/[-_]+/g, ' ')
  if (normalized === 'extra high') return 'xhigh'
  return normalized.replace(/\s+/g, '-')
}

export function nativeChatPickerCatalog(
  provider: NativeChatProvider,
  models: NativeChatModel[] | undefined,
  currentModel: string | undefined,
  fallback: NativePickerCatalog,
): NativePickerCatalog {
  if (models?.length) {
    const selected = models.find((model) => model.id === currentModel) ?? models[0]
    return {
      models: models.map((model) => ({ value: model.id, label: model.label })),
      efforts: selected.efforts.map((effort) => ({
        value: effort,
        label: effortLabel(effort),
      })),
    }
  }
  if (provider !== 'codex') return fallback
  return {
    models: fallback.models.map((model) => ({ ...model, value: model.label })),
    efforts: fallback.efforts.map((effort) => ({
      ...effort,
      value: protocolEffort(effort.label),
    })),
  }
}

export function parseNativeModelCommand(
  text: string,
  catalog: NativePickerCatalog,
): { model?: string; effort?: string } | { error: string } | null {
  const match = text.trim().match(/^\/(model|effort)(?:\s+(.*))?$/i)
  if (!match) return null
  const kind = match[1].toLowerCase() as 'model' | 'effort'
  const article = kind === 'effort' ? 'an' : 'a'
  const argument = match[2]?.trim()
  if (!argument) return { error: `Type /${kind} followed by ${article} ${kind} name.` }
  if (/^\d+(?:,\d+)*$/.test(argument)) {
    return { error: `Use ${article} ${kind} name instead of a legacy picker number.` }
  }
  const options = kind === 'model' ? catalog.models : catalog.efforts
  const option = options.find(
    (candidate) =>
      candidate.value.toLowerCase() === argument.toLowerCase() ||
      candidate.label.toLowerCase() === argument.toLowerCase(),
  )
  if (kind === 'model') return { model: option?.value ?? argument }
  return { effort: option?.value ?? protocolEffort(argument) }
}

export function buildNativeAnswers(draft: NativeAnswerDraft): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(draft).map(([questionId, answer]) => {
      const freeText = answer.freeText.trim()
      return [questionId, freeText ? [...answer.selected, freeText] : answer.selected]
    }),
  )
}

/** Keep slash commands explicit where Orchestra owns their meaning. */
export function classifyNativeDraft(
  draft: string,
  images: string[],
  steer: boolean,
): NativeDraftResult {
  const text = draft.trim()
  const commandName = text.match(/^\/(\S+)/)?.[1]?.toLowerCase()
  if (commandName === 'compact' && text.toLowerCase() === '/compact') {
    if (images.length > 0) {
      return { error: 'Remove attachments before compacting the conversation.' }
    }
    return { command: { kind: 'compact' } }
  }
  if (commandName === 'clear') {
    return {
      error: 'Native chat cannot clear this conversation. Start a new session instead.',
    }
  }
  return {
    command: {
      kind: 'send',
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(steer ? { steer: true } : {}),
    },
  }
}

/** Apply only snapshots that belong to this pane and cannot move it backwards. */
export function newerNativeSnapshot(
  current: NativeChatSnapshot | null | undefined,
  incoming: NativeChatSnapshot | null,
  sessionId: string,
): NativeChatSnapshot | null | undefined {
  if (incoming && incoming.sessionId !== sessionId) return current
  if (current && !incoming) return current
  if (current && incoming && incoming.revision < current.revision) return current
  return incoming
}
