// Modal that walks the user through automated provisioning of the voice
// sidecar's Python venv, dependencies, and speech model. Subscribes to
// `voice:setupProgress` IPC events for live updates and renders a vertical
// checklist with a streaming log pane.
//
// On entry the wizard calls `voiceCheckSetup()` to learn the current stage
// and either:
//   * shows "Ready" + auto-dismisses (rare — the parent only opens the
//     wizard when setup is not ready, but this guards against races), or
//   * shows the appropriate failure stage with retry/install buttons, or
//   * automatically starts `voiceRunSetup()` to drive the state machine.

import { useEffect, useRef, useState } from 'react'
import type { VoiceSetupProgressEvent, VoiceSetupStage, VoiceSetupStatus } from '../../../shared/types'

interface VoiceSetupWizardProps {
  open: boolean
  onClose: () => void
  /** Called once the wizard reaches `ready` so the parent can flip the toggle on. */
  onReady: () => void
  light: boolean
}

interface ChecklistItem {
  key: VoiceSetupStage
  label: string
  match: (stage: VoiceSetupStage) => 'pending' | 'active' | 'done' | 'failed'
}

const CHECKLIST: ChecklistItem[] = [
  {
    key: 'checking_python',
    label: 'Checking Python 3.11+',
    match: (s) => {
      if (s === 'checking_python') return 'active'
      if (s === 'python_missing') return 'failed'
      if (s === 'unknown') return 'pending'
      return 'done'
    },
  },
  {
    key: 'installing_deps',
    label: 'Creating environment & installing dependencies',
    match: (s) => {
      if (s === 'venv_missing' || s === 'installing_deps') return 'active'
      if (s === 'unknown' || s === 'checking_python' || s === 'python_missing') return 'pending'
      if (s === 'failed') return 'failed'
      return 'done'
    },
  },
  {
    key: 'downloading_model',
    label: 'Downloading speech models (~600MB)',
    match: (s) => {
      if (s === 'downloading_model') return 'active'
      if (s === 'ready') return 'done'
      if (s === 'failed') return 'failed'
      return 'pending'
    },
  },
  {
    key: 'ready',
    label: 'Ready',
    match: (s) => (s === 'ready' ? 'done' : 'pending'),
  },
]

export function VoiceSetupWizard({ open, onClose, onReady, light }: VoiceSetupWizardProps) {
  const [status, setStatus] = useState<VoiceSetupStatus | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [showFullLogs, setShowFullLogs] = useState(false)
  const startedRef = useRef(false)

  const bg = light ? '#fff' : '#1a1a1f'
  const txt = light ? '#1a1a1a' : '#eee'
  const mutedTxt = light ? '#666' : '#999'
  const border = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'
  const inputBg = light ? '#f4f4f5' : '#0e0e12'

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.electronAPI.voiceCheckSetup().then((s) => {
      if (cancelled) return
      setStatus(s)
      if (s.stage === 'ready') {
        onReady()
        return
      }
      // Auto-kick setup unless we're stuck on python_missing — that requires
      // explicit user consent before invoking brew install.
      if (!startedRef.current && s.stage !== 'python_missing') {
        startedRef.current = true
        kickoff(false)
      }
    })
    const unsub = window.electronAPI.onVoiceSetupProgress((event: VoiceSetupProgressEvent) => {
      setLogLines((prev) => {
        const next = [...prev, `[${event.stage}] ${event.message}`]
        if (next.length > 500) next.splice(0, next.length - 500)
        return next
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // When stage hits ready, briefly show the green check then auto-dismiss + enable.
  useEffect(() => {
    if (status?.stage === 'ready') {
      const t = setTimeout(() => {
        onReady()
      }, 1000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [status?.stage, onReady])

  async function kickoff(installPython: boolean): Promise<void> {
    setRunning(true)
    try {
      const next = await window.electronAPI.voiceRunSetup({ installPython })
      setStatus(next)
    } finally {
      setRunning(false)
    }
  }

  if (!open) return null

  const stage: VoiceSetupStage = status?.stage ?? 'unknown'
  const failed = stage === 'failed' || stage === 'python_missing'
  const tailLines = logLines.slice(-20)
  const allLines = logLines

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose()
      }}
    >
      <div
        className="w-full max-w-xl rounded-xl shadow-2xl flex flex-col"
        style={{ backgroundColor: bg, border: `1px solid ${border}`, maxHeight: '80vh' }}
      >
        <div className="px-5 py-4" style={{ borderBottom: `1px solid ${border}` }}>
          <h2 className="text-base font-semibold" style={{ color: txt }}>
            Set up Voice
          </h2>
          <p className="text-xs mt-1" style={{ color: mutedTxt }}>
            Orchestra needs Python 3.11+ and a small speech model. This is a one-time setup.
          </p>
        </div>

        <div className="px-5 py-4 space-y-2">
          {CHECKLIST.map((item) => {
            const state = item.match(stage)
            return (
              <div key={item.key} className="flex items-center gap-3">
                <ItemIcon state={state} />
                <span
                  className="text-sm"
                  style={{ color: state === 'pending' ? mutedTxt : txt, opacity: state === 'pending' ? 0.6 : 1 }}
                >
                  {item.label}
                </span>
              </div>
            )
          })}
        </div>

        {status?.message && failed && (
          <div className="px-5 pb-2">
            <div
              className="rounded-md px-3 py-2 text-xs whitespace-pre-wrap break-words"
              style={{ backgroundColor: inputBg, border: `1px solid ${border}`, color: txt }}
            >
              {status.message}
              {status.errorCode && (
                <div className="mt-1 font-mono text-[10px]" style={{ color: mutedTxt }}>
                  code: {status.errorCode}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="px-5 pb-3">
          <pre
            className="text-[10px] font-mono p-2 rounded-md whitespace-pre-wrap break-all max-h-32 overflow-y-auto"
            style={{ backgroundColor: inputBg, border: `1px solid ${border}`, color: mutedTxt }}
          >
            {(showFullLogs ? allLines : tailLines).join('\n') || 'Waiting for output...'}
          </pre>
          <button
            onClick={() => setShowFullLogs((v) => !v)}
            className="text-[10px] mt-1 hover:opacity-80"
            style={{ color: mutedTxt }}
          >
            {showFullLogs ? 'Show last 20 lines' : 'Open full logs'}
          </button>
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: `1px solid ${border}` }}>
          {stage === 'python_missing' && status?.canInstallPython && (
            <button
              onClick={() => kickoff(true)}
              disabled={running}
              className="px-3 py-1.5 text-xs rounded-md font-medium disabled:opacity-50"
              style={{ backgroundColor: '#3b82f6', color: '#fff' }}
            >
              {running ? 'Installing...' : 'Install Python via Homebrew'}
            </button>
          )}
          {failed && (
            <button
              onClick={() => kickoff(false)}
              disabled={running}
              className="px-3 py-1.5 text-xs rounded-md font-medium disabled:opacity-50"
              style={{ backgroundColor: inputBg, border: `1px solid ${border}`, color: txt }}
            >
              {running ? 'Retrying...' : 'Retry'}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={running && stage !== 'failed' && stage !== 'python_missing'}
            className="px-3 py-1.5 text-xs rounded-md disabled:opacity-50"
            style={{ color: mutedTxt }}
          >
            {stage === 'ready' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ItemIcon({ state }: { state: 'pending' | 'active' | 'done' | 'failed' }) {
  if (state === 'done') {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full" style={{ backgroundColor: '#22c55e', color: '#fff', fontSize: 10 }}>
        ✓
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full" style={{ backgroundColor: '#ef4444', color: '#fff', fontSize: 10 }}>
        ✗
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span
        className="block h-4 w-4 rounded-full border-2 border-t-transparent animate-spin"
        style={{ borderColor: '#3b82f6', borderTopColor: 'transparent' }}
      />
    )
  }
  return <span className="block h-4 w-4 rounded-full" style={{ border: '1px solid rgba(127,127,127,0.4)' }} />
}
