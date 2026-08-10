'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'
import { Check, ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'busy' | 'sent' | 'error'

/**
 * Send images from the phone into the attached desktop session. Tap opens the
 * native photo picker straight from the tap gesture — the same thing the chat
 * composer's attach button does. It must stay synchronous: an `await` before
 * the `.click()` (this used to read the clipboard first) spends the user
 * activation, and iOS Safari then silently ignores the picker, which reads as
 * a dead button. Clipboard screenshots still work on desktop through the real
 * `paste` event below. Each image is uploaded to Convex storage and a
 * `sendImage` command tells the desktop bridge to download it and type its
 * local path into the session's prompt (no Enter — you keep composing).
 */
export function ImagePasteButton({ token, sessionId }: { token: string; sessionId: string }) {
  const convex = useConvex()
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const busyRef = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const settle = useCallback((s: 'sent' | 'error') => {
    busyRef.current = false
    setStatus(s)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setStatus('idle'), 1500)
  }, [])

  const uploadOne = useCallback(
    async (blob: Blob) => {
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
    },
    [convex, token, sessionId],
  )

  // Sequential, not parallel: the bridge types one path per command, and the
  // picked order is the order the paths should land in the prompt.
  const upload = useCallback(
    async (blobs: Blob[]) => {
      const images = blobs.filter((b) => !b.type || b.type.startsWith('image/'))
      if (images.length === 0 || busyRef.current) return
      busyRef.current = true
      setStatus('busy')
      try {
        for (const blob of images) await uploadOne(blob)
        settle('sent')
      } catch {
        settle('error')
      }
    },
    [uploadOne, settle],
  )

  // Desktop Cmd/Ctrl-V of a screenshot. A real paste event carries the bytes
  // without any permission prompt, so it needs none of the async dance the tap
  // path can't afford.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith('image/'),
      )
      if (files.length === 0) return
      e.preventDefault()
      void upload(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [upload])

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Allow re-picking the same screenshot back-to-back.
    e.target.value = ''
    if (files.length > 0) void upload(files)
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label="Attach images from photos"
        // Keep the terminal focused so the device keyboard stays open.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (busyRef.current) return
          inputRef.current?.click()
        }}
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
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPick}
      />
    </>
  )
}
