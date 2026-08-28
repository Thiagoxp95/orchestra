// ── Mirrored dev-server list ────────────────────────────────────────────────
// The sidebar's "Servers" branch, mirrored to the web/phone. The phone can't
// reach `localhost`, so what travels is the tailnet (or LAN) URL — the same
// address Expo prints for a device — and only the fields a remote row renders
// from. The scan itself is a couple of process calls, so it runs on its own
// slow clock rather than on every pushState.
import type { MirroredServer, RunningServer } from '../shared/types'
import { scanRunningServers } from './running-servers'

/** Servers come and go with dev tasks — fast enough to feel live, slow enough
 *  to stay off the push path. */
const RESCAN_INTERVAL_MS = 5_000

let catalog: MirroredServer[] = []
let catalogKey = ''
let scannedAt = 0
let inFlight: Promise<void> | null = null

/** Test seam — the module is a singleton cache. */
export function resetServerCatalog(): void {
  catalog = []
  catalogKey = ''
  scannedAt = 0
  inFlight = null
}

export function getServerCatalog(): MirroredServer[] {
  return catalog
}

/** Strip the local-only fields; keep the URL a phone can actually open. */
export function toMirroredServers(servers: RunningServer[]): MirroredServer[] {
  return servers.map((server) => ({
    id: server.id,
    sessionId: server.sessionId,
    pid: server.pid,
    port: server.port,
    name: server.name,
    kind: server.kind,
    url: server.urls.remote,
    ...(server.urls.deepLink ? { deepLink: server.urls.deepLink } : {}),
  }))
}

export function serversFingerprint(servers: MirroredServer[]): string {
  return JSON.stringify(servers)
}

/**
 * Refresh the cached list if it is stale, calling `onChange` only when it
 * actually moved — pushState calls this on every push, and an unconditional
 * callback would make the bridge push itself in a loop.
 */
export function refreshServerCatalog(
  sessionPids: () => Promise<Map<number, string>>,
  onChange: () => void,
  now: number = Date.now(),
): void {
  if (inFlight) return
  if (now - scannedAt < RESCAN_INTERVAL_MS) return
  scannedAt = now
  const run = (async () => {
    try {
      const next = toMirroredServers(await scanRunningServers(await sessionPids()))
      const nextKey = serversFingerprint(next)
      const moved = nextKey !== catalogKey
      catalog = next
      catalogKey = nextKey
      if (moved) onChange()
    } catch (err) {
      console.error('[remote-bridge] server scan failed', err)
    } finally {
      inFlight = null
    }
  })()
  inFlight = run
}
