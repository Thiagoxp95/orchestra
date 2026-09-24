// Pure message bookkeeping for the native chat pane, shared by both transports.

import type { ChatBlock, ChatMessage } from '../../../desktop/src/shared/chat-message'

/** The provider keeps at most this many rows per conversation; so do we. */
export const MESSAGE_CAP = 400

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && a.ts === b.ts && JSON.stringify(a.blocks) === JSON.stringify(b.blocks)
}

/**
 * Fold a partial push into the held list. Identity is the uid: a known uid is
 * replaced IN PLACE (a streaming row grows under the same uid, and must not
 * jump to the end), an unknown one appends in arrival order. Returns `prev`
 * itself when nothing changed, so React sees a stable reference.
 */
export function upsertMessages(prev: ChatMessage[], incoming: ChatMessage[], cap = MESSAGE_CAP): ChatMessage[] {
  if (incoming.length === 0) return prev
  const index = new Map(prev.map((m, i) => [m.uid, i]))
  let next: ChatMessage[] | null = null
  for (const m of incoming) {
    const at = index.get(m.uid)
    const list: ChatMessage[] = next ?? prev
    if (at !== undefined) {
      if (sameMessage(list[at], m)) continue
      next ??= [...prev]
      next[at] = m
    } else {
      next ??= [...prev]
      index.set(m.uid, next.length)
      next.push(m)
    }
  }
  if (!next) return prev
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * The bubble a send shows the instant it fires. `baseline` is how many real
 * user rows existed at send time: the provider records sends in order, so a
 * user row beyond the baseline means this send (or a later one) got through.
 */
export type NativeEcho = { baseline: number; message: ChatMessage }

export function countUserRows(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) if (m.role === 'user') n++
  return n
}

export function makeNativeEcho(text: string, imageCount: number, baseline: number, nonce: string, ts = Date.now()): NativeEcho {
  // Images lead the text, matching how the provider records the message.
  const blocks: ChatBlock[] = Array.from({ length: imageCount }, () => ({ kind: 'image' as const }))
  if (text) blocks.push({ kind: 'text', text })
  // `local:` keeps the uid clear of provider ids and marks the row pending.
  return { baseline, message: { uid: `local:${nonce}`, role: 'user', blocks, ts } }
}

export function pruneNativeEchoes(echoes: NativeEcho[], messages: ChatMessage[]): NativeEcho[] {
  if (echoes.length === 0) return echoes
  const users = countUserRows(messages)
  const kept = echoes.filter((e) => users <= e.baseline)
  return kept.length === echoes.length ? echoes : kept
}
