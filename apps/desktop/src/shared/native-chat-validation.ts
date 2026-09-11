import type { NativeChatCommand, NativeChatSettings } from './native-chat'
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chat command')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid chat command text')
  return value
}
export function parseNativeChatCommand(value: unknown): NativeChatCommand {
  const command = object(value)
  switch (command.kind) {
    case 'start': case 'compact': case 'interrupt': return { kind: command.kind }
    case 'send': {
      const images = command.images ?? []
      if (!Array.isArray(images) || images.length > 4) throw new Error('At most four images are allowed')
      const body = text(command.text, 100_000)
      if (!body.trim() && images.length === 0) throw new Error('Message is empty')
      return { kind: 'send', text: body, images: images.map(i => text(i, 4096)), steer: command.steer === true }
    }
    case 'configure': {
      const raw = object(command.settings)
      const settings: NativeChatSettings = {}
      for (const key of ['model', 'effort'] as const) if (raw[key] !== undefined) {
        const value = text(raw[key], 200).trim()
        if (!value) throw new Error(`Invalid ${key}`)
        settings[key] = value
      }
      if (!settings.model && !settings.effort) throw new Error('No settings supplied')
      return { kind: 'configure', settings }
    }
    case 'respond': {
      const reply = object(command.reply)
      const requestId = text(reply.requestId, 500)
      if (!requestId) throw new Error('Missing request id')
      if (reply.decision !== undefined && reply.decision !== 'allow' && reply.decision !== 'deny') throw new Error('Invalid approval decision')
      let answers: Record<string, string[]> | undefined
      if (reply.answers !== undefined) {
        const entries = Object.entries(object(reply.answers))
        if (entries.length > 20) throw new Error('Too many answers')
        answers = Object.fromEntries(entries.map(([key, values]) => {
          if (!Array.isArray(values) || values.length > 20) throw new Error('Invalid answer')
          return [text(key, 500), values.map(v => text(v, 20_000))]
        }))
      }
      return { kind: 'respond', reply: { requestId, ...(reply.decision ? { decision: reply.decision } : {}), ...(answers ? { answers } : {}) } }
    }
    default: throw new Error('Unsupported chat command')
  }
}
