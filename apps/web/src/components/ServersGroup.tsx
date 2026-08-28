'use client'

import { useState } from 'react'
import type { MirroredServer } from '@/lib/servers'
import { cn } from '@/lib/utils'

/**
 * The "Servers" branch under a worktree: the dev servers its sessions are
 * running, as tappable links. The URL comes from the desktop already pointed at
 * a host this phone can reach (tailnet, else LAN) — tapping opens it in a new
 * tab, and the × asks before killing the process and freeing the port.
 */
export function ServersGroup({
  servers,
  onKill,
}: {
  servers: MirroredServer[]
  onKill: (server: MirroredServer) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  if (servers.length === 0) return null

  return (
    <div className="pl-3">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground"
      >
        <span className={cn('transition-transform', collapsed && '-rotate-90')}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
        <span className="font-medium">Servers</span>
        <span className="opacity-60">{servers.length}</span>
      </button>

      {!collapsed && (
        <div className="space-y-0.5">
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 active:bg-sidebar-accent"
            >
              <a
                href={server.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-2"
              >
                <span className="shrink-0 rounded bg-foreground/85 px-1.5 py-0.5 font-mono text-[10px] font-medium text-background">
                  {server.port}
                </span>
                <span className="min-w-0 truncate text-[13px] text-foreground">{server.name}</span>
                {server.kind !== 'server' && server.kind !== server.name && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{server.kind}</span>
                )}
              </a>
              {server.deepLink && (
                <a
                  href={server.deepLink}
                  className="shrink-0 rounded border border-sidebar-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  exp
                </a>
              )}
              <button
                type="button"
                aria-label={`Kill ${server.name} on port ${server.port}`}
                onClick={() => onKill(server)}
                className="shrink-0 px-1 text-muted-foreground"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
