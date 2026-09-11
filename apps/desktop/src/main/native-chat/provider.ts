import type { ChatMessage } from '../agent-message-model'
import type { NativeChatModel, NativeChatReply, NativeChatRequest, NativeChatSettings, NativeChatStatus } from '../../shared/native-chat'

export type ProviderEvent =
  | { kind: 'settings'; settings: NativeChatSettings }
  | { kind: 'catalog'; models: NativeChatModel[] }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'status'; status: NativeChatStatus; error?: string }
  | { kind: 'messages'; messages: ChatMessage[] }
  | { kind: 'request'; request: NativeChatRequest }
  | { kind: 'request-resolved'; requestId: string }

export type ProviderOpenOptions = {
  cwd: string
  conversationId?: string
  settings: NativeChatSettings
}

/** send resolves on provider acceptance, never after the whole agent turn. */
export interface NativeChatAdapter {
  open(options: ProviderOpenOptions): Promise<void>
  send(input: { text: string; images: string[]; settings: NativeChatSettings }): Promise<void>
  configure(settings: NativeChatSettings): Promise<void>
  compact(): Promise<void>
  interrupt(): Promise<void>
  respond(reply: NativeChatReply): Promise<void>
  close(): Promise<void>
}
export type ProviderEventSink = (event: ProviderEvent) => void
export type NativeChatAdapterFactory = (emit: ProviderEventSink) => NativeChatAdapter
