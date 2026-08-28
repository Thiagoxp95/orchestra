import { useState } from 'react'
import type { RunningServer } from '../../../shared/types'
import { isLightColor } from '../utils/color'
import { Tooltip } from './Tooltip'

interface ServersGroupProps {
  servers: RunningServer[]
  wsColor: string
  txtColor: string
  /** Label of the session that owns a server, for the row's tooltip. */
  sessionLabel: (sessionId: string) => string | null
  /** Focus the owning session (right-click / middle-click on a row). */
  onFocusSession: (sessionId: string) => void
  /** Called once a server's port is confirmed free. */
  onKilled: (id: string) => void
  /** Ask the sidebar to confirm before killing every server in this worktree. */
  onKillAll: (servers: RunningServer[]) => void
}

function ServerIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <line x1="4.5" y1="4.75" x2="4.6" y2="4.75" />
      <line x1="4.5" y1="11.25" x2="4.6" y2="11.25" />
    </svg>
  )
}

/**
 * The "Servers" branch of a worktree: one row per dev server the worktree's
 * sessions are listening on. A row is the URL — clicking opens it, the × kills
 * the process tree and frees the port.
 */
export function ServersGroup({
  servers,
  wsColor,
  txtColor,
  sessionLabel,
  onFocusSession,
  onKilled,
  onKillAll,
}: ServersGroupProps): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [killing, setKilling] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  if (servers.length === 0) return null

  const light = isLightColor(wsColor)
  const hoverBg = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'

  const kill = async (server: RunningServer): Promise<void> => {
    setKilling((prev) => new Set(prev).add(server.id))
    try {
      const result = await window.electronAPI.killRunningServer(server.pid, server.port)
      if (result.success) onKilled(server.id)
    } finally {
      setKilling((prev) => {
        const next = new Set(prev)
        next.delete(server.id)
        return next
      })
    }
  }

  const copy = (server: RunningServer, url: string): void => {
    void navigator.clipboard.writeText(url)
    setCopied(server.id)
    setTimeout(() => setCopied((prev) => (prev === server.id ? null : prev)), 1200)
  }

  return (
    <div className="group/servers mt-0.5">
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex items-center gap-1.5 w-full px-3 py-1 rounded-md transition-colors text-left"
        style={{ color: txtColor }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = hoverBg }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
      >
        <span
          className="shrink-0 transition-transform duration-150"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', opacity: 0.5 }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
        <span className="shrink-0 opacity-60"><ServerIcon color={txtColor} /></span>
        <span className="text-[11px] font-medium">Servers</span>
        <span className="text-[10px] opacity-50">{servers.length}</span>
        <span className="flex-1" />
        <span
          onClick={(e) => { e.stopPropagation(); onKillAll(servers) }}
          className="text-[10px] opacity-0 group-hover/servers:opacity-60 hover:!opacity-100 transition-opacity cursor-pointer"
          title="Kill every server in this worktree"
        >
          Kill all
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-0.5">
          {servers.map((server) => {
            const owner = sessionLabel(server.sessionId)
            const shareUrl = server.urls.tailnet ?? server.urls.lan ?? server.urls.local
            const isKilling = killing.has(server.id)
            return (
              <div
                key={server.id}
                className="group/server flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md cursor-pointer transition-colors"
                style={{ color: txtColor, opacity: isKilling ? 0.4 : 1 }}
                title={`${server.urls.local}${owner ? ` · ${owner}` : ''}${server.command ? `\n${server.command}` : ''}`}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = hoverBg }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
                onClick={() => { void window.electronAPI.openExternalUrl(server.urls.local) }}
                onContextMenu={(e) => { e.preventDefault(); onFocusSession(server.sessionId) }}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onFocusSession(server.sessionId) } }}
              >
                <span
                  className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded shrink-0"
                  style={{ backgroundColor: txtColor, color: wsColor }}
                >
                  {server.port}
                </span>
                <span className="text-[11px] truncate">{server.name}</span>
                {server.kind !== 'server' && server.kind !== server.name && (
                  <span className="text-[10px] opacity-40 truncate">{server.kind}</span>
                )}
                <span className="flex-1" />
                {server.urls.deepLink && (
                  <Tooltip text="Copy Expo link" side="right" bgColor={wsColor} textColor={txtColor}>
                    <span
                      onClick={(e) => { e.stopPropagation(); copy(server, server.urls.deepLink!) }}
                      className="text-[9px] font-mono px-1 py-0.5 rounded border shrink-0 opacity-0 group-hover/server:opacity-70 hover:!opacity-100 transition-opacity"
                      style={{ borderColor: `${txtColor}55` }}
                    >
                      exp
                    </span>
                  </Tooltip>
                )}
                <Tooltip
                  text={copied === server.id ? 'Copied' : `Copy ${shareUrl}`}
                  side="right"
                  bgColor={wsColor}
                  textColor={txtColor}
                  maxWidth={280}
                >
                  <span
                    onClick={(e) => { e.stopPropagation(); copy(server, shareUrl) }}
                    className="shrink-0 opacity-0 group-hover/server:opacity-60 hover:!opacity-100 transition-opacity"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                      <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" />
                    </svg>
                  </span>
                </Tooltip>
                <span
                  onClick={(e) => { e.stopPropagation(); void kill(server) }}
                  className="shrink-0 opacity-0 group-hover/server:opacity-60 hover:!opacity-100 transition-opacity"
                  title={`Kill ${server.name} (pid ${server.pid}) and free port ${server.port}`}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="4" y1="4" x2="12" y2="12" />
                    <line x1="12" y1="4" x2="4" y2="12" />
                  </svg>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
