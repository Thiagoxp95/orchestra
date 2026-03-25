import { useRef, useCallback } from 'react'

interface EmojiPickerProps {
  value?: string
  onChange: (emoji: string) => void
  bg?: string
  txt?: string
  mutedTxt?: string
}

/** Extracts the first emoji (grapheme cluster) from a string. */
function firstEmoji(str: string): string | undefined {
  if (!str) return undefined
  // Segmenter gives us proper grapheme clusters (handles skin tones, ZWJ sequences, flags, etc.)
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const { segment } of seg.segment(str)) {
      // Check it's not plain ASCII text
      if (/\p{Emoji_Presentation}|[\u200d\ufe0f]/u.test(segment)) return segment
      // Single-char emojis like digits won't match above, but multi-byte will
      if (segment.length > 1 && /\p{Emoji}/u.test(segment)) return segment
    }
  }
  return undefined
}

export function EmojiPicker({ value, onChange, bg = '#2a2a3e', mutedTxt = '#888' }: EmojiPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClick = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Trigger native macOS emoji picker
    // In Electron/Chromium, app.showEmojiPanel() is the standard way,
    // but from renderer we can use the input method: Cmd+Ctrl+Space is wired natively.
    // We'll use the Electron method via IPC if available, otherwise the input approach works.
    try {
      ;(window as any).electronAPI?.showEmojiPanel?.()
    } catch {
      // fallback: the user can use Cmd+Ctrl+Space
    }
  }, [])

  const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const raw = e.currentTarget.value
    const emoji = firstEmoji(raw)
    if (emoji) {
      onChange(emoji)
    }
    // Always clear the input so it's ready for the next pick
    e.currentTarget.value = ''
  }, [onChange])

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        className="text-3xl w-12 h-12 flex items-center justify-center rounded-lg hover:scale-110 transition-transform cursor-pointer"
        style={{ backgroundColor: bg }}
        title="Click to pick emoji (or ⌃⌘Space)"
      >
        {value || '📁'}
      </button>
      <span className="text-xs" style={{ color: mutedTxt }}>Click to pick emoji</span>
      {/* Hidden input to capture emoji picker output */}
      <input
        ref={inputRef}
        type="text"
        className="sr-only"
        onInput={handleInput}
        onChange={() => {}} // suppress React warning
        aria-label="Emoji input"
      />
    </div>
  )
}
