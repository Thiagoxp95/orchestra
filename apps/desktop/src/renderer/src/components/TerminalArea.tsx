import { useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { TerminalInstance } from './TerminalInstance'
import { DynamicIcon } from './DynamicIcon'
import type { TerminalSession } from '../../../shared/types'

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function darkenColor(hex: string): string {
  const [h, s] = hexToHsl(hex)
  return hslToHex(h, Math.min(s, 40), 14)
}

export function TerminalArea() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const runAction = useAppStore((s) => s.runAction)
  const mountedRef = useRef<Set<string>>(new Set())

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const termBg = workspace ? darkenColor(workspace.color) : '#1a1a2e'
  const sessionIds = workspace
    ? workspace.trees.flatMap((t) => t.sessionIds)
    : []

  // Track which sessions have been activated (lazy mount)
  if (activeSessionId) {
    mountedRef.current.add(activeSessionId)
  }

  // Mount sessions that need eager startup even if they are not focused yet.
  for (const sid of sessionIds) {
    const session = sessions[sid]
    if ((session?.initialCommand || session?.launchProfile?.kind === 'exec') && !mountedRef.current.has(sid)) {
      mountedRef.current.add(sid)
    }
  }

  if (!activeWorkspaceId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-xl text-gray-500" style={{ backgroundColor: termBg }}>
        <div className="w-full h-3 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex-1 flex items-center justify-center">
          <p>Create a workspace to get started</p>
        </div>
      </div>
    )
  }

  if (sessionIds.length === 0) {
    const actions = workspace?.customActions ?? []
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-xl text-gray-600/50" style={{ backgroundColor: termBg }}>
        <div className="w-full h-3 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          {actions.length > 0 && (
            <div className="flex items-center gap-4">
              {actions.map((action) => (
                <button
                  key={action.id}
                  onClick={() => runAction(activeWorkspaceId!, action)}
                  className="flex flex-col items-center gap-1.5 cursor-pointer hover:text-gray-400 transition-colors"
                >
                  <DynamicIcon name={action.icon} size={22} color="currentColor" />
                  <span className="text-xs">{action.name}</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-sm">Get started with an action</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 rounded-xl p-2 pt-0 relative" style={{ backgroundColor: termBg }}>
      <div
        className="h-3 w-full shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {sessionIds.map((sid) => {
        if (!mountedRef.current.has(sid)) return null
        const session: TerminalSession | undefined = sessions[sid]
        return (
          <div
            key={sid}
            className="absolute inset-2 top-5"
            style={{
              visibility: sid === activeSessionId ? 'visible' : 'hidden',
              zIndex: sid === activeSessionId ? 1 : 0
            }}
          >
            <TerminalInstance sessionId={sid} cwd={session?.cwd || workspace?.trees.find((t) => t.sessionIds.includes(sid))?.rootDir || '~'} termBg={termBg} initialCommand={session?.initialCommand} launchProfile={session?.launchProfile} isActive={sid === activeSessionId} />
          </div>
        )
      })}
    </div>
  )
}
