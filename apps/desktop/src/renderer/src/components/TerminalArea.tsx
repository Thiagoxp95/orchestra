import { useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { TerminalInstance } from './TerminalInstance'
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
  const claudeLastResponse = useAppStore((s) => s.claudeLastResponse)
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
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-xl text-gray-500" style={{ backgroundColor: termBg }}>
        <div className="w-full h-3 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex-1 flex items-center justify-center">
          <p>Create a session in "{workspace?.name}"</p>
        </div>
      </div>
    )
  }

  const activeResponse = activeSessionId ? claudeLastResponse[activeSessionId] : null

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
            style={{ display: sid === activeSessionId ? 'block' : 'none' }}
          >
            <TerminalInstance sessionId={sid} cwd={session?.cwd || workspace?.trees.find((t) => t.sessionIds.includes(sid))?.rootDir || '~'} termBg={termBg} initialCommand={session?.initialCommand} isActive={sid === activeSessionId} />
          </div>
        )
      })}
      {/* Claude last response overlay */}
      {activeResponse && (
        <div
          className="absolute top-6 right-4 max-w-sm z-10 pointer-events-none"
        >
          <div
            className="px-3 py-2 rounded-lg text-xs leading-relaxed backdrop-blur-md"
            style={{
              backgroundColor: 'rgba(0,0,0,0.65)',
              color: 'rgba(255,255,255,0.75)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <span className="text-[10px] font-medium uppercase tracking-wider block mb-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
              Claude last response
            </span>
            {activeResponse}
          </div>
        </div>
      )}
    </div>
  )
}
