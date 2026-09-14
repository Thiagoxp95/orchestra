// lib/sync/protocol.ts
//
// Wire protocol between this app and the server embedded in the Orchestra
// desktop app. Mirrored verbatim from
// apps/desktop/src/shared/sync-protocol.ts — the two apps build
// independently, so the duplicate is deliberate. Keep them equal.

/** Bumped when a change would make an old client misread a new server. */
export const SYNC_PROTOCOL_VERSION = 1

export const SYNC_PATH = '/api/sync'

/** Client → server. */
export type SyncClientMessage =
  | { t: 'sub'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'unsub'; id: number }
  | { t: 'call'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'ping' }

/** Server → client. */
export type SyncServerMessage =
  | { t: 'ready'; protocol: number; buildId: string }
  | { t: 'value'; id: number; value: unknown }
  | { t: 'ack'; id: number; value: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'pong' }

export function isSyncServerMessage(value: unknown): value is SyncServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string'
}
