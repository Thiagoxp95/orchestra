import { useState } from 'react'
import { useClaudeHookInstallState } from '../hooks/useClaudeHookInstallState'
import { useAppStore } from '../store/app-store'

export function ClaudeHookInstallBanner() {
  const { state, install } = useClaudeHookInstallState()
  const anyClaudeRunning = useAppStore((s) => s.anyClaudeRunning)
  const dismissed = useAppStore((s) => s.claudeBannerDismissed)
  const setDismissed = useAppStore((s) => s.setClaudeBannerDismissed)
  const [busy, setBusy] = useState(false)

  if (dismissed) return null
  if (!state || state.status === 'installed' || state.status === 'installed-stale') return null
  if (!anyClaudeRunning) return null

  const handleInstall = async () => {
    setBusy(true)
    try {
      const res = await install()
      if (!res.ok) {
        // eslint-disable-next-line no-alert
        alert(`Claude hook install failed: ${res.reason}${res.detail ? '\n\n' + res.detail : ''}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-2 text-sm shrink-0"
      style={{
        backgroundColor: '#1a1a2e',
        borderBottom: '1px solid #2a2a3e',
        color: '#e5e7eb',
      }}
    >
      <div className="flex-1">
        <strong>Install Claude Code hooks</strong>
        <span className="opacity-80">
          {' '}— Orchestra uses Claude Code hooks to track session state (working, idle, needs input). One click installs them to{' '}
          <code>~/.claude/settings.json</code>.
        </span>
      </div>
      <div className="flex gap-2 items-center ml-4">
        <button
          onClick={handleInstall}
          disabled={busy}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs"
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="px-2 py-1 rounded hover:bg-white/10 text-white/70 text-xs"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
