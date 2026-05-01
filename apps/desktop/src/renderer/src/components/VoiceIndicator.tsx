import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { VoiceEvent, VoiceStatus } from '../../../shared/types'

interface VoiceIndicatorProps {
  wsColor: string
  textColor: string
}

type Visual =
  | { kind: 'idle' }
  | { kind: 'awake' }
  | { kind: 'no-match'; text: string }

const NO_MATCH_DURATION_MS = 1500

/**
 * Footer voice listener indicator.
 *
 *   - Renders nothing when the feature is disabled.
 *   - Idle (sidecar listening for the wake word): a small dim mic dot.
 *   - Awake (post wake-word): the dot pulses in the workspace accent color.
 *   - No match: a small bubble fades in above the footer with the heard text
 *     for ~1.5s, then fades. No bubble for timeouts (silent return to idle).
 *
 * Subscribes to the IPC voice event/status streams; performs no audio work.
 */
export function VoiceIndicator({ wsColor, textColor }: VoiceIndicatorProps) {
  const enabled = useAppStore((s) => s.settings.voice?.enabled ?? false)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [visual, setVisual] = useState<Visual>({ kind: 'idle' })
  const noMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let mounted = true
    window.electronAPI.voiceGetStatus().then((s) => { if (mounted) setStatus(s) })
    const unsubStatus = window.electronAPI.onVoiceStatus((s) => setStatus(s))
    const unsubEvent = window.electronAPI.onVoiceEvent((event: VoiceEvent) => {
      if (event.type === 'wake') {
        setVisual({ kind: 'awake' })
        if (noMatchTimerRef.current) {
          clearTimeout(noMatchTimerRef.current)
          noMatchTimerRef.current = null
        }
        return
      }
      if (event.type === 'matched' || event.type === 'timeout') {
        setVisual({ kind: 'idle' })
        if (noMatchTimerRef.current) {
          clearTimeout(noMatchTimerRef.current)
          noMatchTimerRef.current = null
        }
        return
      }
      if (event.type === 'no_match') {
        setVisual({ kind: 'no-match', text: event.text })
        if (noMatchTimerRef.current) clearTimeout(noMatchTimerRef.current)
        noMatchTimerRef.current = setTimeout(() => {
          setVisual({ kind: 'idle' })
          noMatchTimerRef.current = null
        }, NO_MATCH_DURATION_MS)
      }
    })
    return () => {
      mounted = false
      unsubStatus()
      unsubEvent()
      if (noMatchTimerRef.current) clearTimeout(noMatchTimerRef.current)
    }
  }, [])

  if (!enabled) return null
  // While the manager is starting up the dot still renders so the user gets
  // visual confirmation the toggle took effect; the dimmer state covers it.
  const isError = status?.state === 'error'

  const baseDotStyle: React.CSSProperties = {
    backgroundColor: visual.kind === 'awake' ? wsColor : textColor,
    boxShadow: visual.kind === 'awake' ? `0 0 6px ${wsColor}` : undefined,
  }

  return (
    <div className="relative flex items-center px-1">
      {visual.kind === 'no-match' && (
        <div
          className="absolute bottom-7 right-0 px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap pointer-events-none animate-fade-in"
          style={{
            color: textColor,
            backgroundColor: `${textColor}15`,
            border: `1px solid ${textColor}30`,
          }}
        >
          <span style={{ opacity: 0.85 }}>{visual.text || '—'}</span>
          <span style={{ opacity: 0.5 }}> · no match</span>
        </div>
      )}
      <div
        title={isError ? `Voice error: ${status?.lastError?.code ?? 'unknown'}` : 'Voice listening'}
        className={`w-2 h-2 rounded-full transition-opacity ${visual.kind === 'awake' ? 'animate-pulse' : ''}`}
        style={{
          ...baseDotStyle,
          opacity: isError ? 0.6 : visual.kind === 'awake' ? 1 : 0.3,
          backgroundColor: isError ? '#ff5577' : baseDotStyle.backgroundColor,
        }}
      />
    </div>
  )
}
