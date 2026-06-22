'use client'
import { useState } from 'react'
import { useAuth } from '../lib/useAuth'

export function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const token = await signIn(email, password)
    setBusy(false)
    if (token) onSignedIn(token)
    else setError('Invalid credentials')
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '15vh auto', display: 'grid', gap: 12 }}>
      <h1 style={{ fontSize: 20 }}>Orchestra Web</h1>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
        autoComplete="username" required style={{ padding: 10 }} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password" required style={{ padding: 10 }} />
      <button type="submit" disabled={busy} style={{ padding: 10 }}>{busy ? '…' : 'Sign in'}</button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </form>
  )
}
