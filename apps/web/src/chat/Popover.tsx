'use client'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * The chat root's tint (inline token overrides + data-tint). Popovers portal to
 * <body> and so leave `.chat-scope`; they re-enter it with these values.
 */
export type ChatScope = { style?: CSSProperties; tint: 'light' | 'dark' }
export const ChatScopeContext = createContext<ChatScope>({ tint: 'dark' })

/**
 * Fixed-position panel anchored ABOVE its trigger (the composer sits at the
 * bottom of the pane). Portalled to <body>: the pane lives under the phone's
 * SessionRoll translate3d container, and a transform makes that div the
 * containing block for `position: fixed`, so without the portal the panel
 * would be laid out against the pane box, not the screen.
 */
export function AnchoredPopover({
  anchor,
  width,
  align = 'start',
  onClose,
  children,
}: {
  anchor: HTMLElement
  width: number
  align?: 'start' | 'end'
  onClose: () => void
  children: ReactNode
}) {
  const scope = useContext(ChatScopeContext)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const w = Math.min(width, vw - 16)
      const preferred = align === 'end' ? rect.right - w : rect.left
      const left = Math.min(Math.max(preferred, 8), vw - w - 8)
      setStyle({
        left,
        bottom: window.innerHeight - rect.top + 8,
        width: w,
        // Cap against the visual viewport (--app-h on the phone) so browser
        // chrome can't eat the top of the panel.
        maxHeight: `min(21.625rem, calc(var(--app-h, 100vh) - ${window.innerHeight - rect.top + 24}px))`,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, width, align])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  if (!style) return null
  return createPortal(
    // Transparent scrim, no backdrop-filter of its own: the panel carries one,
    // and two stacked over a live terminal recomposite the screen per repaint.
    <div
      className="chat-scope fixed inset-0 z-[100] touch-manipulation"
      style={scope.style}
      data-tint={scope.tint}
      onPointerDown={onClose}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="dropdown-glass surface-grain fixed flex flex-col overflow-hidden rounded-lg border border-border/70 text-foreground shadow-xl"
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
