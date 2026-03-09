import { useRef, useEffect, useState } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import type { PromptRecord } from '../../../shared/types'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  initialCommand?: string
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand)
  const [promptHistory, setPromptHistory] = useState<PromptRecord[]>([])
  const [showOverlay, setShowOverlay] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive])

  // Poll prompt history every 2s when active
  useEffect(() => {
    if (!isActive) return

    const fetchHistory = () => {
      window.electronAPI.getPromptHistory(sessionId).then((records) => {
        setPromptHistory(records)
      }).catch(() => {})
    }

    fetchHistory()
    const interval = setInterval(fetchHistory, 2000)
    return () => clearInterval(interval)
  }, [sessionId, isActive])

  // Auto-scroll to bottom when new prompts arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [promptHistory.length])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* Debug: Prompt History Overlay */}
      {showOverlay && (
        <div
          className="absolute bottom-3 right-3 z-20"
          style={{ width: 320, maxHeight: '50%' }}
        >
          <div
            className="rounded-lg overflow-hidden flex flex-col"
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.75)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-3 py-1.5 shrink-0"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}
            >
              <span
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: 'rgba(255, 255, 255, 0.4)' }}
              >
                Prompt History ({promptHistory.length})
              </span>
              <button
                onClick={() => setShowOverlay(false)}
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 cursor-pointer"
                style={{ color: 'rgba(255, 255, 255, 0.35)' }}
              >
                Hide
              </button>
            </div>

            {/* Prompt list */}
            <div
              ref={scrollRef}
              className="overflow-y-auto"
              style={{ maxHeight: 300 }}
            >
              {promptHistory.length === 0 ? (
                <div
                  className="px-3 py-3 text-[11px] text-center"
                  style={{ color: 'rgba(255, 255, 255, 0.25)' }}
                >
                  No prompts yet. Type something and press Enter.
                </div>
              ) : (
                promptHistory.map((record, i) => (
                  <div
                    key={i}
                    className="px-3 py-1.5"
                    style={{
                      borderBottom: i < promptHistory.length - 1
                        ? '1px solid rgba(255, 255, 255, 0.05)'
                        : undefined,
                    }}
                  >
                    <div
                      className="text-[10px] mb-0.5"
                      style={{ color: 'rgba(255, 255, 255, 0.25)' }}
                    >
                      {new Date(record.submittedAt).toLocaleTimeString()}
                    </div>
                    <div
                      className="text-[12px] leading-snug break-words"
                      style={{
                        color: 'rgba(255, 255, 255, 0.8)',
                        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                      }}
                    >
                      {record.text}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Minimized show button */}
      {!showOverlay && (
        <button
          onClick={() => setShowOverlay(true)}
          className="absolute bottom-3 right-3 z-20 px-2 py-1 rounded text-[10px] cursor-pointer hover:bg-white/15"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            color: 'rgba(255, 255, 255, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          Prompts
        </button>
      )}
    </div>
  )
}
