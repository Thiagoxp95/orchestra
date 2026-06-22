'use client'
import { useState } from 'react'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useAuth } from '../lib/useAuth'
import { SignIn } from '../components/SignIn'
import { AppSidebar } from '../components/Sidebar'
import { TerminalPane } from '../components/Terminal'

export default function Page() {
  const { token, hydrated } = useAuth()
  const [selected, setSelected] = useState<string | null>(null)

  // Until the stored token is read post-mount, render nothing — this keeps the
  // server HTML and first client render identical (no hydration mismatch) and
  // avoids flashing the sign-in form to an already-authenticated user.
  if (!hydrated) return null

  if (!token) return <SignIn onSignedIn={() => location.reload()} />

  return (
    <SidebarProvider>
      <AppSidebar
        token={token}
        selectedId={selected}
        onSelect={setSelected}
        onClose={(sid) => setSelected((cur) => (cur === sid ? null : cur))}
      />
      <SidebarInset className="h-svh min-h-0">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          <span className="truncate text-sm text-muted-foreground">
            {selected ? 'Session' : 'Select a session'}
          </span>
        </header>
        <div className="min-h-0 flex-1">
          {selected ? (
            <TerminalPane key={selected} token={token} sessionId={selected} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Select a session</div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
