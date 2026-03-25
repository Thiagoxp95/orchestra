import * as http from 'node:http'
import { URL } from 'node:url'
import { resolveAgentActualSessionId } from './agent-session-aliases'
import { applyClaudeHookEvent } from './claude-session-watcher'
import { applyCodexHookEvent } from './codex-session-watcher'
import {
  CLAUDE_HOOK_VERSION,
  ensureClaudeHookRuntimeInstalled,
  type ClaudeHookEventType,
} from './claude-hook-runtime'
import {
  CODEX_HOOK_VERSION,
  ensureCodexHookRuntimeInstalled,
  type CodexHookEventType,
} from './codex-hook-runtime'

let server: http.Server | null = null
let currentHookPort: number | null = null

export function mapClaudeHookEventType(raw: string | null): ClaudeHookEventType | null {
  if (raw === 'Start' || raw === 'Stop' || raw === 'PermissionRequest') {
    return raw
  }
  return null
}

export function mapCodexHookEventType(raw: string | null): CodexHookEventType | null {
  if (raw === 'Start' || raw === 'Stop' || raw === 'PermissionRequest' || raw === 'UserInputRequest') {
    return raw
  }
  return null
}

export function getClaudeHookPort(): number | null {
  return currentHookPort
}

export async function startClaudeHookServer(): Promise<number> {
  if (server && currentHookPort != null) return currentHookPort

  ensureClaudeHookRuntimeInstalled()
  ensureCodexHookRuntimeInstalled()

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    if (url.pathname !== '/claude/hook' && url.pathname !== '/codex/hook') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not_found' }))
      return
    }

    const rawSessionId = url.searchParams.get('sessionId')?.trim()

    if (!rawSessionId) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid_hook_payload' }))
      return
    }
    const sessionId = resolveAgentActualSessionId(rawSessionId)

    const version = url.searchParams.get('version')
    if (url.pathname === '/claude/hook') {
      const eventType = mapClaudeHookEventType(url.searchParams.get('eventType'))
      if (!eventType) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid_hook_payload' }))
        return
      }
      if (version && version !== CLAUDE_HOOK_VERSION) {
        console.warn('[claude-hook] received hook version %s, expected %s', version, CLAUDE_HOOK_VERSION)
      }
      const userMessage = url.searchParams.get('userMessage')?.trim() || undefined
      applyClaudeHookEvent(sessionId, eventType, userMessage)
    } else {
      const eventType = mapCodexHookEventType(url.searchParams.get('eventType'))
      if (!eventType) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid_hook_payload' }))
        return
      }
      if (version && version !== CODEX_HOOK_VERSION) {
        console.warn('[codex-hook] received hook version %s, expected %s', version, CODEX_HOOK_VERSION)
      }
      applyCodexHookEvent(sessionId, eventType)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  server.on('error', (error) => {
    console.error('[claude-hook] server error:', error)
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('listening', () => {
      const address = server!.address()
      currentHookPort = typeof address === 'object' && address ? address.port : null
      console.log('[claude-hook] listening on http://127.0.0.1:%d', currentHookPort)
      resolve()
    })
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1')
  })

  if (currentHookPort == null) {
    throw new Error('Claude hook server did not expose a port')
  }

  return currentHookPort
}

export function stopClaudeHookServer(): void {
  if (!server) return
  server.close()
  server = null
  currentHookPort = null
}
