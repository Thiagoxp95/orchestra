// Helpers for the web→desktop `sendImage` command: the phone uploads a
// screenshot to Convex storage, the bridge downloads it here and types the
// local path into the session's prompt. Pure logic is kept separate from the
// fs wrappers so it is unit-testable, mirroring the other remote-bridge
// helpers (sanitize/batcher/create-worktree). No Electron imports.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SendImagePayload {
  storageId: string
  mime: string
}

export function normalizeSendImagePayload(payload: unknown): SendImagePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  return {
    storageId: String(p.storageId ?? ''),
    mime: String(p.mime ?? '') || 'image/png',
  }
}

// Claude Code reads image paths by extension; svg intentionally maps to the
// png fallback (agents can't ingest it as an image anyway).
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

export function imageExtension(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'png'
}

// Two images can land in the same millisecond (double-tap on a slow poll
// cycle); a per-process counter keeps the names unique.
let fileCounter = 0

export function imageFileName(mime: string, timestamp: number): string {
  fileCounter++
  return `remote-${timestamp}-${fileCounter}.${imageExtension(mime)}`
}

// Downloaded images are only needed until the agent has read them; a day is
// generous headroom for a session the user leaves open overnight.
export const IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function selectStaleImages(
  entries: { name: string; mtimeMs: number }[],
  now: number,
): string[] {
  return entries.filter((e) => now - e.mtimeMs > IMAGE_MAX_AGE_MS).map((e) => e.name)
}

export function remoteImagesDir(): string {
  return join(homedir(), '.orchestra', 'remote-images')
}

/** Write the downloaded bytes to the images dir and return the absolute path. */
export async function saveRemoteImage(bytes: Uint8Array, mime: string): Promise<string> {
  const dir = remoteImagesDir()
  await fs.mkdir(dir, { recursive: true })
  const filePath = join(dir, imageFileName(mime, Date.now()))
  await fs.writeFile(filePath, bytes)
  return filePath
}

/** Delete images past IMAGE_MAX_AGE_MS. Best-effort: errors are swallowed. */
export async function pruneRemoteImages(): Promise<void> {
  try {
    const dir = remoteImagesDir()
    const names = await fs.readdir(dir)
    const entries: { name: string; mtimeMs: number }[] = []
    for (const name of names) {
      try {
        const stat = await fs.stat(join(dir, name))
        entries.push({ name, mtimeMs: stat.mtimeMs })
      } catch {
        // raced with a concurrent delete — skip
      }
    }
    for (const name of selectStaleImages(entries, Date.now())) {
      try {
        await fs.unlink(join(dir, name))
      } catch {
        // best-effort
      }
    }
  } catch {
    // dir doesn't exist yet — nothing to prune
  }
}
