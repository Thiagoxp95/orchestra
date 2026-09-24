// The chat UI's only door to the outside world. The web app implements it over
// the sync socket (lib/chat-transport.ts), the desktop over IPC
// (renderer/src/chat/desktop-transport.ts); nothing under chat/ knows which.

import type { NativeChatCommand, NativeChatSnapshot, NativeChatView } from '../../../desktop/src/shared/native-chat'
import type { ChatMessage } from '../../../desktop/src/shared/chat-message'

export interface ChatTransport {
  /** undefined = loading, null = no native record (the terminal owns the session). */
  useSnapshot(sessionId: string): NativeChatSnapshot | null | undefined
  /** Bounded (≤400) latest rows, uid-stable; rows update in place while streaming. */
  useMessages(sessionId: string): ChatMessage[] | undefined
  /** Throws Error(message) on failure; the UI shows it inline. */
  command(sessionId: string, command: NativeChatCommand, images?: File[]): Promise<void>
  /** The TUI⇄SDK handoff. May take seconds; throws with a user-facing message. */
  setView(sessionId: string, view: NativeChatView): Promise<NativeChatSnapshot | null>
}

export type ChatContextUsage = { usedTokens: number; contextWindow: number }
