import { useState, useEffect } from 'react'
import { useAppStore } from '../store/app-store'

interface DebugState {
  schedulerEntries: Record<string, { nextRunAt: number; lastRunAt: number }>
  runningIds: string[]
  tickIntervalActive: boolean
  actionsFound: {
    actionId: string
    name: string
    schedule: any
    automationEnabled: any
    nextRunAt: number
    isDue: boolean
  }[]
}

export function AutomationDebugOverlay() {
  const [debug, setDebug] = useState<DebugState | null>(null)
  const [visible, setVisible] = useState(false)
  const automationNextRunAt = useAppStore((s) => s.automationNextRunAt)

  useEffect(() => {
    if (!visible) return
    const poll = () => {
      window.electronAPI.getAutomationDebugState().then(setDebug)
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [visible])

  // Toggle with Cmd+Shift+D
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === 'A') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!visible) return null

  const now = Date.now()

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        right: 12,
        width: 420,
        maxHeight: 500,
        backgroundColor: 'rgba(0,0,0,0.92)',
        color: '#e0e0e0',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.1)',
        fontSize: 11,
        fontFamily: 'monospace',
        zIndex: 9999,
        overflow: 'auto',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ color: '#fff' }}>Automation Debug</strong>
        <button onClick={() => setVisible(false)} style={{ color: '#888', cursor: 'pointer', background: 'none', border: 'none', fontSize: 11 }}>
          close
        </button>
      </div>

      {!debug ? (
        <div style={{ color: '#888' }}>Loading...</div>
      ) : (
        <>
          <div style={{ marginBottom: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: debug.tickIntervalActive ? '#3fb950' : '#f85149' }}>
              Tick interval: {debug.tickIntervalActive ? 'ACTIVE' : 'INACTIVE'}
            </span>
            {' | '}
            Running: {debug.runningIds.length > 0 ? debug.runningIds.join(', ') : 'none'}
          </div>

          <div style={{ marginBottom: 4, color: '#888' }}>
            Renderer sync data: {Object.keys(automationNextRunAt).length} entries
          </div>

          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: '#ccc' }}>Actions with schedule ({debug.actionsFound.length}):</strong>
            {debug.actionsFound.length === 0 && (
              <div style={{ color: '#f85149', marginTop: 4 }}>
                No actions found with a schedule! Check that automationEnabled is truthy.
              </div>
            )}
            {debug.actionsFound.map((a) => {
              const secsUntil = Math.round((a.nextRunAt - now) / 1000)
              return (
                <div
                  key={a.actionId}
                  style={{
                    marginTop: 6,
                    padding: '6px 8px',
                    borderRadius: 4,
                    backgroundColor: a.isDue ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)',
                    border: a.isDue ? '1px solid rgba(59,130,246,0.3)' : '1px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#fff' }}>{a.name}</span>
                    <span style={{ color: a.isDue ? '#3b82f6' : '#888' }}>
                      {a.isDue ? 'DUE' : `in ${secsUntil}s`}
                    </span>
                  </div>
                  <div style={{ color: '#888', marginTop: 2 }}>
                    mode: {a.schedule?.mode} | enabled: {String(a.automationEnabled)} | id: {a.actionId.slice(0, 8)}
                  </div>
                  <div style={{ color: '#666', marginTop: 1 }}>
                    nextRunAt: {new Date(a.nextRunAt).toLocaleTimeString()}
                  </div>
                </div>
              )
            })}
          </div>

          <div>
            <strong style={{ color: '#ccc' }}>Scheduler entries ({Object.keys(debug.schedulerEntries).length}):</strong>
            {Object.entries(debug.schedulerEntries).map(([id, entry]) => (
              <div key={id} style={{ color: '#888', marginTop: 2 }}>
                {id.slice(0, 8)}: next={new Date(entry.nextRunAt).toLocaleTimeString()} last={entry.lastRunAt ? new Date(entry.lastRunAt).toLocaleTimeString() : 'never'}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
