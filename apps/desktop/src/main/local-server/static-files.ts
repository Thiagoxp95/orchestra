// src/main/local-server/static-files.ts
//
// Serves the phone web app out of the desktop bundle. The app used to run as a
// separate `next start` process behind its own launch agent; it is now a static
// export shipped inside Electron, which is why the desktop and the phone can no
// longer disagree about which version they are running.

import { createReadStream, promises as fs } from 'node:fs'
import { join, normalize, extname, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * Exported for tests: path traversal is the one way a static handler can hand
 * out files the phone was never meant to see.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const resolved = normalize(join(root, decoded))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  return resolved
}

async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * Pick the file that answers a request, following static-export conventions:
 * a directory is served by its index.html, and an extensionless path may have
 * been exported as `<path>.html`.
 */
async function pickFile(root: string, urlPath: string): Promise<string | null> {
  const base = resolveStaticPath(root, urlPath)
  if (!base) return null
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.html`, join(base, 'index.html')]
  for (const candidate of candidates) {
    if (await statFile(candidate)) return candidate
  }
  return null
}

export interface StaticHandler {
  (req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean>
}

export function createStaticHandler(root: string): StaticHandler {
  return async (req, res, urlPath) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false

    // Hashed bundles under /_next/static are immutable. The HTML shell is not:
    // iOS relaunches a home-screen PWA from its cached start page without
    // revalidating, which is how phones used to get stranded on old bundles.
    const file = (await pickFile(root, urlPath)) ?? (await pickFile(root, '/index.html'))
    if (!file) return false

    const stat = await statFile(file)
    if (!stat) return false

    const immutable = urlPath.startsWith('/_next/static/')
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
    })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    createReadStream(file).pipe(res)
    return true
  }
}
