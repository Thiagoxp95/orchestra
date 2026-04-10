import { useCallback, useState } from 'react'
import { useClaudeHookInstallState } from '../hooks/useClaudeHookInstallState'
import { Tooltip } from './Tooltip'

interface Props {
  wsColor: string
  txtColor: string
}

export function ClaudeHooksButton({ wsColor, txtColor }: Props) {
  const { state, install } = useClaudeHookInstallState()
  const [busy, setBusy] = useState(false)

  const handleClick = useCallback(async () => {
    if (!state) return

    if (state.status === 'error' && state.reason === 'settings-malformed') {
      // Open the file for manual fix
      window.electronAPI.openExternalPath('~/.claude/settings.json').catch(() => {})
      return
    }
    if (state.status === 'installed' || state.status === 'installed-stale') return

    setBusy(true)
    try {
      const res = await install()
      if (!res.ok) {
        // eslint-disable-next-line no-alert
        alert(`Claude hook install failed: ${res.reason}${res.detail ? '\n\n' + res.detail : ''}`)
      }
      // Success path: state-changed IPC will flip the button to the green check.
    } finally {
      setBusy(false)
    }
  }, [state, install])

  if (!state) return null

  const baseClass = 'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors'
  const baseStyle = {
    color: txtColor,
    backgroundColor: `${txtColor}10`,
    border: `1px solid ${txtColor}18`,
  }

  // Installed (or installed-stale): green checkmark, disabled cursor
  if (state.status === 'installed' || state.status === 'installed-stale') {
    const version = state.status === 'installed' ? state.version : state.currentVersion
    return (
      <Tooltip side="top" text={`Claude Code hooks installed (v${version})`} bgColor={wsColor} textColor={txtColor}>
        <div className={`${baseClass} opacity-60 cursor-default`} style={baseStyle}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 8 7 12 13 4" />
          </svg>
          <span>Hooks installed</span>
        </div>
      </Tooltip>
    )
  }

  // Settings.json malformed → red warning, click opens the file
  if (state.status === 'error' && state.reason === 'settings-malformed') {
    return (
      <Tooltip
        side="top"
        text="Can't install — your ~/.claude/settings.json has a syntax error. Click to open."
        bgColor={wsColor}
        textColor={txtColor}
      >
        <button
          onClick={handleClick}
          className={`${baseClass} hover:opacity-80`}
          style={{ ...baseStyle, color: '#f87171', borderColor: '#f8717133' }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2 L14 13 L2 13 Z" />
            <line x1="8" y1="6" x2="8" y2="10" />
            <circle cx="8" cy="11.5" r="0.5" />
          </svg>
          <span>Fix settings.json</span>
        </button>
      </Tooltip>
    )
  }

  // not-installed (or other error states — treat as clickable install)
  return (
    <Tooltip side="top" text="Install Claude Code hooks into ~/.claude/settings.json" bgColor={wsColor} textColor={txtColor}>
      <button
        onClick={handleClick}
        disabled={busy}
        className={`${baseClass} hover:opacity-80 disabled:opacity-40`}
        style={baseStyle}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2 L8 10" />
          <path d="M5 7 L8 10 L11 7" />
          <path d="M3 13 L13 13" />
        </svg>
        <span>{busy ? 'Installing…' : 'Install Claude hooks'}</span>
      </button>
    </Tooltip>
  )
}
