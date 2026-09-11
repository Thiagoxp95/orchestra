import { useRef, useEffect } from 'react'
import { ArrowDown } from 'lucide-react'
import { useTerminal } from '../hooks/useTerminal'
import { useJumpToLatest } from '../hooks/useJumpToLatest'
import { TerminalAttachments } from './TerminalAttachments'
import type { TerminalLaunchProfile } from '../../../shared/types'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  workspaceColor?: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand, launchProfile, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand, launchProfile, isActive)
  const { showLatest, jumpToLatest } = useJumpToLatest(termRef, sessionId)
  useEffect(() => { if (isActive) termRef.current?.focus() }, [isActive])
  return <div className="relative h-full w-full p-3">
    <TerminalAttachments active={isActive} paste={text => { termRef.current?.paste(text); termRef.current?.focus() }}>
      <div ref={containerRef} className="h-full w-full" />
    </TerminalAttachments>
    {/* Jump to the live end, for every pane — agent or plain shell. */}
    {showLatest && (
      <button
        type="button"
        // Keep xterm's focus: this is for reading, not for typing elsewhere.
        onMouseDown={e => e.preventDefault()}
        onClick={jumpToLatest}
        className="absolute bottom-5 right-5 flex items-center gap-1.5 rounded-full bg-black/70 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg backdrop-blur hover:bg-black/90"
      >
        <ArrowDown size={16} /> Latest
      </button>
    )}
  </div>
}
