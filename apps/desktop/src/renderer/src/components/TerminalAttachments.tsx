import { useRef, useState, type ReactNode } from 'react'
import { ImagePlus } from 'lucide-react'

/** Images are staged locally and pasted into the CLI's own input, without sending Enter. */
export function TerminalAttachments({ children, paste, active = true }: {
  children: ReactNode
  paste(text: string): void
  active?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stage = async (files: File[]) => {
    if (busyRef.current) return
    const images = files.filter(file => file.type.startsWith('image/'))
    if (!images.length) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const paths: string[] = []
      for (const file of images.slice(0, 4)) {
        paths.push(await window.electronAPI.chatSaveImage(new Uint8Array(await file.arrayBuffer()), file.type))
      }
      paste(paths.map(path => /\s/.test(path) ? JSON.stringify(path) : path).join(' ') + ' ')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Image attachment failed')
    } finally { busyRef.current = false; setBusy(false) }
  }
  return <div className="relative flex h-full min-h-0 flex-col"
    onPasteCapture={event => {
      const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
      if (!files.length) return
      event.preventDefault(); event.stopPropagation(); void stage(files)
    }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDrop={event => {
      const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'))
      if (!files.length) return
      event.preventDefault(); event.stopPropagation(); void stage(files)
    }}>
    <div className="min-h-0 flex-1">{children}</div>
    {active && <div className="flex shrink-0 items-center gap-2 pt-1">
      <button type="button" title="Attach image" aria-label="Attach image" disabled={busy}
        className="rounded p-1.5 opacity-65 hover:opacity-100 focus-visible:outline focus-visible:outline-2 disabled:opacity-30"
        onClick={() => input.current?.click()}><ImagePlus size={16} /></button>
      {busy && <span role="status" className="text-xs opacity-65">Attaching image…</span>}
      {error && <span role="alert" className="text-xs">{error}</span>}
    </div>}
    <input ref={input} type="file" accept="image/*" multiple hidden onChange={event => {
      void stage(Array.from(event.target.files ?? [])); event.target.value = ''
    }} />
  </div>
}
