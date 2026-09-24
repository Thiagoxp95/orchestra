// The desktop half of the chat transport: the native-chat IPC surface in the
// preload. One module-level store per window, so every pane (and the header
// toggle) reading the same session shares one fetch and one set of pushes.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { upsertMessages, type ChatContextUsage, type ChatTransport } from '@chat'
import type { NativeChatSnapshot } from '../../../shared/native-chat'
import type { ChatMessage } from '../../../shared/chat-message'
import { newerNativeSnapshot } from '../../../shared/native-chat-ui'

const snapshots = new Map<string, NativeChatSnapshot | null>()
const messages = new Map<string, ChatMessage[]>()
/** Sessions whose initial history fetch has answered. */
const messagesLoaded = new Set<string>()
const listeners = new Map<string, Set<() => void>>()
const fetched = new Set<string>()
let wired = false

function emit(sessionId: string): void {
  listeners.get(sessionId)?.forEach((listener) => listener())
}

function applySnapshot(sessionId: string, incoming: NativeChatSnapshot | null): void {
  const current = snapshots.get(sessionId)
  const next = newerNativeSnapshot(current, incoming, sessionId)
  if (next === current && snapshots.has(sessionId)) return
  const handedToChat = next?.view === 'chat' && current?.view !== 'chat'
  snapshots.set(sessionId, next ?? null)
  // The handoff seeds the chat with the terminal's history: re-read it.
  if (handedToChat && current !== undefined) loadMessages(sessionId)
  emit(sessionId)
}

function loadMessages(sessionId: string): void {
  window.electronAPI
    .nativeChatMessages(sessionId)
    .then((rows) => {
      // Pushes that landed while the fetch was in flight are newer than it.
      messages.set(sessionId, upsertMessages(rows ?? [], messages.get(sessionId) ?? []))
    })
    .catch(() => {
      if (!messages.has(sessionId)) messages.set(sessionId, [])
    })
    .finally(() => {
      messagesLoaded.add(sessionId)
      emit(sessionId)
    })
}

function wire(): void {
  if (wired) return
  wired = true
  window.electronAPI.onNativeChatState((snapshot) => applySnapshot(snapshot.sessionId, snapshot))
  window.electronAPI.onNativeChatMessages((sessionId, rows) => {
    const held = messages.get(sessionId) ?? []
    const next = upsertMessages(held, rows)
    if (next === held && messages.has(sessionId)) return
    messages.set(sessionId, next)
    emit(sessionId)
  })
}

function subscribe(sessionId: string, listener: () => void): () => void {
  wire()
  let set = listeners.get(sessionId)
  if (!set) listeners.set(sessionId, (set = new Set()))
  set.add(listener)
  if (!fetched.has(sessionId)) {
    fetched.add(sessionId)
    window.electronAPI
      .nativeChatGet(sessionId)
      .then((snapshot) => applySnapshot(sessionId, snapshot))
      .catch(() => applySnapshot(sessionId, null))
    loadMessages(sessionId)
  }
  return () => {
    set.delete(listener)
  }
}

/** ipcRenderer.invoke wraps main's error: "Error invoking remote method 'x': Error: <message>". */
function userFacing(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''))
}

function useSessionStore<T>(sessionId: string, read: () => T): T {
  const sub = useCallback((listener: () => void) => subscribe(sessionId, listener), [sessionId])
  return useSyncExternalStore(sub, read)
}

export const desktopChatTransport: ChatTransport = {
  useSnapshot: (sessionId) =>
    useSessionStore(sessionId, () => (snapshots.has(sessionId) ? snapshots.get(sessionId) ?? null : undefined)),
  useMessages: (sessionId) =>
    useSessionStore(sessionId, () => (messagesLoaded.has(sessionId) ? messages.get(sessionId) : undefined)),
  async command(sessionId, command, images) {
    try {
      let next = command
      if (images?.length && command.kind === 'send') {
        const paths: string[] = []
        for (const file of images) {
          paths.push(await window.electronAPI.chatSaveImage(new Uint8Array(await file.arrayBuffer()), file.type || 'image/png'))
        }
        next = { ...command, images: paths }
      }
      const snapshot = await window.electronAPI.nativeChatCommand(sessionId, next)
      if (snapshot) applySnapshot(sessionId, snapshot)
    } catch (cause) {
      throw userFacing(cause)
    }
  },
  async setView(sessionId, view) {
    try {
      const snapshot = await window.electronAPI.nativeChatSetView(sessionId, view)
      applySnapshot(sessionId, snapshot)
      return snapshot
    } catch (cause) {
      throw userFacing(cause)
    }
  },
}

const CONTEXT_POLL_MS = 5000

/** The composer's context ring: main's transcript-derived usage, polled while shown. */
export function useAgentContext(sessionId: string, enabled: boolean): ChatContextUsage | null {
  const [usage, setUsage] = useState<ChatContextUsage | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = () => {
      window.electronAPI
        .chatAgentContext()
        .then((all) => {
          const info = all[sessionId]
          if (!cancelled) setUsage(info ? { usedTokens: info.usedTokens, contextWindow: info.contextWindow } : null)
        })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, CONTEXT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, enabled])
  return usage
}
