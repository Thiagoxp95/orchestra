'use client'
import { useQuery } from 'convex/react'
import { anyApi } from 'convex/server'

interface SafeTree { rootDir: string; sessionIds: string[]; displayName?: string }
interface SafeWorkspace { id: string; name: string; color: string; emoji?: string; trees: SafeTree[]; activeTreeIndex: number }
interface SafeSession { label: string; processStatus: string; cwd: string; workspaceId: string; actionIcon?: string }
interface LiveStatus { work?: 'idle' | 'working'; exited?: boolean; label?: string }

export function Sidebar({
  token,
  selectedId,
  onSelect,
}: {
  token: string
  selectedId: string | null
  onSelect: (sessionId: string) => void
}) {
  const state = useQuery(anyApi.remote.getRemoteState, { token })

  if (state === undefined) return <div style={{ padding: 12 }}>Loading…</div>
  if (state === null) return <div style={{ padding: 12 }}>Desktop not connected</div>

  const workspaces = (state.workspaces ?? []) as SafeWorkspace[]
  const sessions = (state.sessions ?? {}) as Record<string, SafeSession>
  const liveStatus = (state.liveStatus ?? {}) as Record<string, LiveStatus>

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {workspaces.map((ws) => (
        <div key={ws.id} style={{ marginBottom: 8 }}>
          <div style={{ padding: '6px 10px', fontWeight: 600 }}>
            {ws.emoji ? ws.emoji + ' ' : ''}{ws.name}
          </div>
          {ws.trees.map((tree, ti) => (
            <div key={ti} style={{ paddingLeft: 12 }}>
              {tree.displayName && (
                <div style={{ fontSize: 11, opacity: 0.6, padding: '2px 10px' }}>{tree.displayName}</div>
              )}
              {tree.sessionIds.map((sid) => {
                const s = sessions[sid]
                if (!s) return null
                const status = liveStatus[sid]
                const dot = status?.exited ? '⚪️' : status?.work === 'working' ? '🟢' : '⚪️'
                return (
                  <button
                    key={sid}
                    onClick={() => onSelect(sid)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                      background: sid === selectedId ? '#2b2b2b' : 'transparent', color: 'inherit',
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    {dot} {status?.label ?? s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
