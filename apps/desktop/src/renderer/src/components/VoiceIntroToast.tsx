// One-time discovery banner shown the first time the user runs a build that
// includes the voice feature. Clicking the banner opens the VoiceSetupWizard
// directly so the user can provision the environment without hunting through
// Settings. The "seen" state lives in electron-store under `voice.introSeen`.

import { useEffect, useState } from 'react'
import { VoiceSetupWizard } from './VoiceSetupWizard'

export function VoiceIntroToast() {
  const [visible, setVisible] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.voiceGetIntroSeen().then((seen) => {
      if (cancelled) return
      if (!seen) setVisible(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    setVisible(false)
    window.electronAPI.voiceMarkIntroSeen().catch(() => {})
  }

  if (!visible && !wizardOpen) return null

  return (
    <>
      {visible && (
        <div className="fixed bottom-4 left-4 z-50 pointer-events-auto">
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg animate-toast-in"
            style={{
              backgroundColor: '#1a1a2e',
              border: '1px solid rgba(255,255,255,0.12)',
              maxWidth: 360,
            }}
          >
            <button
              onClick={() => {
                dismiss()
                setWizardOpen(true)
              }}
              className="flex flex-col items-start gap-1 text-left hover:brightness-110 transition-all"
            >
              <span
                className="text-[10px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: '#3b82f6' }}
              >
                New: Voice control
              </span>
              <span className="text-[14px] font-semibold" style={{ color: 'rgba(255,255,255,0.92)' }}>
                Click to enable hands-free actions.
              </span>
            </button>
            <span
              onClick={dismiss}
              className="text-[12px] opacity-50 hover:opacity-100 cursor-pointer self-start"
              style={{ color: '#fff' }}
            >
              ✕
            </span>
          </div>
        </div>
      )}
      {wizardOpen && (
        <VoiceSetupWizard
          open={wizardOpen}
          light={false}
          onClose={() => setWizardOpen(false)}
          onReady={() => {
            setWizardOpen(false)
          }}
        />
      )}
    </>
  )
}
