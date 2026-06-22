'use client'
import { useState } from 'react'
import { useAuth } from '../lib/useAuth'
import { SignIn } from '../components/SignIn'
import { Sidebar } from '../components/Sidebar'
import { TerminalPane } from '../components/Terminal'

export default function Page() {
  const { token } = useAuth()
  const [selected, setSelected] = useState<string | null>(null)

  // Page and SignIn hold separate useAuth instances, so Page won't re-render
  // when SignIn updates its own token state. Reload to pick up the stored token.
  if (!token) return <SignIn onSignedIn={() => location.reload()} />

  return (
    <div style={{ display: 'flex', height: '100dvh', color: '#eee', background: '#1a1a1a' }}>
      <div style={{ width: 240, borderRight: '1px solid #333', flexShrink: 0 }}>
        <Sidebar token={token} selectedId={selected} onSelect={setSelected} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected ? (
          <TerminalPane key={selected} token={token} sessionId={selected} />
        ) : (
          <div style={{ padding: 16, opacity: 0.6 }}>Select a session</div>
        )}
      </div>
    </div>
  )
}
