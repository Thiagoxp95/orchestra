// Dev servers mirrored from the desktop (remoteState.servers). The desktop
// resolves each listening port back to the session that started it and sends
// the URL a device other than that Mac can actually open — a tailnet host when
// Tailscale is up, the LAN address otherwise. `localhost` never travels.

export type MirroredServer = {
  id: string
  sessionId: string
  pid: number
  port: number
  name: string
  kind: string
  url: string
  deepLink?: string
}

/** Only the fields the row needs, and only if the desktop actually sent them. */
export function safeServers(value: unknown): MirroredServer[] {
  if (!Array.isArray(value)) return []
  const out: MirroredServer[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.sessionId !== 'string') continue
    if (typeof s.port !== 'number' || typeof s.url !== 'string') continue
    out.push({
      id: s.id,
      sessionId: s.sessionId,
      pid: typeof s.pid === 'number' ? s.pid : 0,
      port: s.port,
      name: typeof s.name === 'string' ? s.name : String(s.port),
      kind: typeof s.kind === 'string' ? s.kind : 'server',
      url: s.url,
      ...(typeof s.deepLink === 'string' ? { deepLink: s.deepLink } : {}),
    })
  }
  return out
}

/** The servers started by any session in one worktree, lowest port first. */
export function serversForTree(
  servers: MirroredServer[],
  sessionIds: readonly string[],
): MirroredServer[] {
  const owned = new Set(sessionIds)
  return servers.filter((s) => owned.has(s.sessionId)).sort((a, b) => a.port - b.port)
}
