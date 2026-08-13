import { useRef, useEffect } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import { SessionChat, useViewMode, ViewModeToggle } from '../chat/SessionChat'
import { textColor } from '../chat/lib/workspace-color'
import { useAppStore } from '../store/app-store'
import { isAgentSession } from '../chat/lib/agent-session'
import type { TerminalLaunchProfile } from '../../../shared/types'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  /** The raw workspace color — the chat overlay tints itself from it. */
  workspaceColor?: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, workspaceColor, initialCommand, launchProfile, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand, launchProfile, isActive)
  const [viewMode, setViewMode] = useViewMode()
  const processStatus = useAppStore((s) => s.sessions[sessionId]?.processStatus)

  // The view mode is a global habit, but chat is only offered where there's a
  // conversation behind the pane. A shell/dev-server session ignores the
  // preference and stays on the terminal without clearing it for the agents.
  const chatAvailable = isAgentSession(processStatus)
  const effectiveMode = chatAvailable ? viewMode : 'terminal'

  useEffect(() => {
    // Chat owns the keyboard while it is up — focusing xterm underneath would
    // steal every keystroke from the composer.
    if (isActive && effectiveMode === 'terminal' && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive, effectiveMode])

  const ink = textColor(workspaceColor ?? '#1a1a2e')

  return (
    <div className="relative flex flex-col w-full h-full p-3">
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
        {/* The terminal stays MOUNTED under the chat rather than being swapped
            out: xterm re-attaching would re-seed the whole scrollback and
            re-negotiate the PTY grid every time the pill is tapped. */}
        {effectiveMode === 'chat' && (
          <div className="absolute inset-0 z-10">
            <SessionChat
              sessionId={sessionId}
              color={workspaceColor}
              onShowTerminal={() => setViewMode('terminal')}
            />
          </div>
        )}
      </div>
      {isActive && chatAvailable && (
        <ViewModeToggle mode={effectiveMode} onChange={setViewMode} ink={ink} />
      )}
    </div>
  )
}
