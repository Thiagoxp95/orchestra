'use client'
import { useEffect, useRef, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'
import { Check, ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'busy' | 'sent' | 'error'

/**
 * Send a screenshot from the phone into the attached desktop session. Tap reads
 * an image off the clipboard (iOS shows its "Paste" permission bubble); when the
 * clipboard has no image — or the API is unavailable/denied — it falls back to
 * the native photo picker, where screenshots land instantly. The image is
 * uploaded to Convex storage and a `sendImage` command tells the desktop bridge
 * to download it and type its local path into the session's prompt (no Enter —
 * you keep composing from the phone).
 */
export function ImagePasteButton({ token, sessionId }: { token: string; sessionId: string }) {
  const convex = useConvex()
  const inputRef = useRef<HTMLInputElement>(null)
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

  const upload = async (blob: Blob) => {
    setStatus('busy')
    try {
      const mime = blob.type || 'image/png'
      const url = (await convex.mutation(anyApi.remote.generateUploadUrl, { token })) as string
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: blob })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      const { storageId } = (await res.json()) as { storageId: string }
      await convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId,
        kind: 'sendImage',
        payload: { storageId, mime },
      })
      settle('sent')
    } catch {
      settle('error')
    }
  }

  const onClick = async () => {
    if (status === 'busy') return
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) {
          void upload(await item.getType(type))
          return
        }
      }
    } catch {
      // Clipboard unsupported or permission denied — fall through to the picker.
    }
    inputRef.current?.click()
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Allow re-picking the same screenshot back-to-back.
    e.target.value = ''
    if (file) void upload(file)
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label="Send image from clipboard or photos"
        // Keep the terminal focused so the device keyboard stays open.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void onClick()}
        className={cn(
          'h-9 flex-1 min-w-0 px-0 text-xs font-medium',
          status === 'error' && 'border-destructive text-destructive',
        )}
      >
        {status === 'busy' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : status === 'sent' ? (
          <Check className="size-4" />
        ) : status === 'error' ? (
          <X className="size-4" />
        ) : (
          <ImagePlus className="size-4" />
        )}
      </Button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
    </>
  )
}
