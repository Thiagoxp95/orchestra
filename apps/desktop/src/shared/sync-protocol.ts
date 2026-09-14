// src/shared/sync-protocol.ts
//
// Wire protocol between the phone web app and the server embedded in Electron
// main (src/main/local-server). One WebSocket carries every reactive read and
// every write, replacing what used to be a Convex deployment.
//
// This file is mirrored verbatim at apps/web/src/lib/sync/protocol.ts. The two
// apps build independently, so the duplicate is deliberate — keep them equal.

/** Bumped when a change would make an old client misread a new server. */
export const SYNC_PROTOCOL_VERSION = 1

export const SYNC_PATH = '/api/sync'

/** Client → server. */
export type SyncClientMessage =
  /** Open a live subscription. The server replies immediately with the current
   *  value, then again on every change, until `unsub`. */
  | { t: 'sub'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'unsub'; id: number }
  /** One-shot write. Always answered with `ack` or `err` carrying the same id. */
  | { t: 'call'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'ping' }

/** Server → client. */
export type SyncServerMessage =
  | { t: 'ready'; protocol: number; buildId: string }
  /** A subscription's current value: the first one after `sub`, and every change after. */
  | { t: 'value'; id: number; value: unknown }
  | { t: 'ack'; id: number; value: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'pong' }

export function isSyncServerMessage(value: unknown): value is SyncServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string'
}
