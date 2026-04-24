import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AGENT_CONTROLS,
  mergeControls,
  resolveSendSteps,
  type AgentProvider,
  type Control,
  type ControlEntry,
} from '../../../shared/agent-controls'
import { useAppStore } from '../store/app-store'
import { Tooltip } from './Tooltip'

const api = window.electronAPI

interface Props {
  wsColor: string
  txtColor: string
}

export function AgentFooterControls({ wsColor, txtColor }: Props) {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const status = useAppStore((s) =>
    activeSessionId ? s.sessions[activeSessionId]?.processStatus : undefined,
  )
  const overrides = useAppStore((s) => s.settings.agentFooterControls)

  if (!activeSessionId || (status !== 'claude' && status !== 'codex')) return null

  const provider = status as AgentProvider
  const controls = mergeControls(DEFAULT_AGENT_CONTROLS[provider], overrides?.[provider])
  if (controls.length === 0) return null

  return (
    <>
      {controls.map((control) => (
        <ControlDropdown
          key={control.id}
          control={control}
          sessionId={activeSessionId}
          wsColor={wsColor}
          txtColor={txtColor}
        />
      ))}
    </>
  )
}

async function sendEntry(sessionId: string, entry: ControlEntry): Promise<void> {
  const resolved = resolveSendSteps(entry.send)
  for (const step of resolved) {
    if (step.kind === 'write') {
      api.writeTerminal(sessionId, step.data)
    } else {
      await new Promise((resolve) => setTimeout(resolve, step.ms))
    }
  }
}

interface ControlDropdownProps {
  control: Control
  sessionId: string
  wsColor: string
  txtColor: string
}

function ControlDropdown({ control, sessionId, wsColor, txtColor }: ControlDropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handlePick = (entry: ControlEntry) => {
    setOpen(false)
    void sendEntry(sessionId, entry)
  }

  // Single-entry controls act as direct buttons (skip the menu step).
  const isSingleEntry = control.entries.length === 1

  return (
    <div ref={rootRef} className="relative">
      <Tooltip side="top" text={control.label} bgColor={wsColor} textColor={txtColor}>
        <button
          onClick={() => {
            if (isSingleEntry) {
              handlePick(control.entries[0])
            } else {
              setOpen((v) => !v)
            }
          }}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
          style={{
            color: txtColor,
            backgroundColor: `${txtColor}10`,
            border: `1px solid ${txtColor}18`,
          }}
        >
          <span>{control.label}</span>
          {!isSingleEntry && (
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 2.5 4 5.5 7 2.5" />
            </svg>
          )}
        </button>
      </Tooltip>

      {open && !isSingleEntry && (
        <div
          className="absolute right-0 bottom-full mb-1 min-w-[10rem] rounded-md shadow-xl border z-50 py-1"
          style={{
            backgroundColor: wsColor,
            borderColor: `${txtColor}20`,
            color: txtColor,
          }}
        >
          {control.entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => handlePick(entry)}
              className="block w-full text-left px-3 py-1 text-[11px] hover:opacity-80 transition-colors"
              style={{ color: txtColor }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
