// src/main/local-server/uploads.ts
//
// Images pasted on the phone. These used to go up to Convex file storage and
// come back down over HTTP; now the browser posts straight to this process and
// the bytes are written where the agent can read them, so there is no upload,
// download, or blob to delete afterwards.
//
// Uploads are addressed by an opaque id, never by path. The phone is on the
// tailnet and is not otherwise trusted to name a file: handing it a path would
// let it ask the desktop to type any file on the Mac into a prompt.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { saveRemoteImage } from '../remote-bridge-image'

/** Matches the largest screenshot a phone realistically pastes. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
])

interface Upload {
  path: string
  at: number
}

const uploads = new Map<string, Upload>()

/** Unclaimed uploads are abandoned pastes; the file itself is reaped separately. */
const UPLOAD_TTL_MS = 60 * 60_000

export function isAllowedUploadMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime.toLowerCase())
}

/** Store bytes and return the id the phone passes back in a `sendImage`. */
export async function storeUpload(bytes: Uint8Array, mime: string): Promise<string> {
  const path = await saveRemoteImage(bytes, mime)
  const storageId = randomUUID()
  uploads.set(storageId, { path, at: Date.now() })
  return storageId
}

/** Resolve an id to its path, or null when unknown. Never trusts the input. */
export function resolveUpload(storageId: string): string | null {
  return uploads.get(storageId)?.path ?? null
}

/** Called once the agent has been handed the path. */
export function releaseUpload(storageId: string): void {
  uploads.delete(storageId)
}

/** Drop ids for uploads the phone never sent, and delete their files. */
export async function reapUploads(now: number = Date.now()): Promise<void> {
  for (const [id, upload] of uploads) {
    if (now - upload.at <= UPLOAD_TTL_MS) continue
    uploads.delete(id)
    try {
      await fs.unlink(upload.path)
    } catch {
      // Already gone, or claimed and moved — nothing to do.
    }
  }
}

/** Test seam. */
export function resetUploads(): void {
  uploads.clear()
}
