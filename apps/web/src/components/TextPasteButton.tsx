'use client'
import { api, useSync } from '../lib/sync'
import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardPaste, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { releaseHiddenKeyboardFocus } from '@/lib/viewport'

type Status = 'idle' | 'sent' | 'error'

/**
 * Paste text from the phone's clipboard into the attached desktop session. The
 * mirror's hidden xterm textarea is never focused, so the OS keyboard's own
 * paste can't reach the PTY — this button reads the clipboard on the tap gesture
 * (iOS shows its "Paste" bubble) and relays it as a plain `write`, exactly like
 * typing. No Enter is sent, so you can review/edit before submitting. Pairs with
 * the terminal's long-press "Copy" so text moves between sessions.
 */
export function TextPasteButton({ sessionId, onPaste }: { sessionId: string; onPaste?: (data: string) => boolean }) {
  const sync = useSync()
  const [status, setStatus] = useState<Status>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const settle = (s: 'sent' | 'error') => {
    setStatus(s)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setStatus('idle'), 1500)
  }

  const onClick = async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      settle('error') // clipboard unsupported or permission denied
      return
    }
    if (!text) {
      settle('error')
      return
    }
    try {
      if (onPaste) { settle(onPaste(text) ? 'sent' : 'error'); return }
      await sync.call(api.remote.sendCommand, {
        sessionId,
        kind: 'write',
        payload: { data: text },
      })
      settle('sent')
    } catch {
      settle('error')
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label="Paste text from clipboard"
      // Keep an open keyboard open, but let go of one that is already hidden —
      // Android re-summons the IME for a still-focused editable on any touch.
      onPointerDown={() => releaseHiddenKeyboardFocus()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void onClick()}
      className={cn(
        'h-11 flex-1 min-w-0 px-0 text-xs font-medium',
        status === 'error' && 'border-destructive text-destructive',
      )}
    >
      {status === 'sent' ? (
        <Check className="size-4" />
      ) : status === 'error' ? (
        <X className="size-4" />
      ) : (
        <ClipboardPaste className="size-4" />
      )}
    </Button>
  )
}
