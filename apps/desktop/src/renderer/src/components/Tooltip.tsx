import { useState, useRef, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  text: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom'
  delay?: number
  bgColor?: string
  textColor?: string
  maxWidth?: number
}

export function Tooltip({ text, children, side = 'right', delay = 300, bgColor, textColor, maxWidth }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const triggerRef = useRef<HTMLDivElement>(null)

  const getRect = useCallback(() => {
    const el = triggerRef.current
    if (!el) return null
    // contents divs have zero rect, measure the first child instead
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0 && el.firstElementChild) {
      return el.firstElementChild.getBoundingClientRect()
    }
    return rect
  }, [])

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => {
      const rect = getRect()
      if (rect) {
        if (side === 'right') {
          setPos({ top: rect.top + rect.height / 2, left: rect.right + 8 })
        } else if (side === 'top') {
          setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
        } else {
          setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 })
        }
      }
      setVisible(true)
    }, delay)
  }, [delay, side, getRect])

  const hide = useCallback(() => {
    clearTimeout(timerRef.current)
    setVisible(false)
  }, [])

  const tooltip = visible ? (
    <div
      className="fixed z-[99999] pointer-events-none"
      style={{
        top: pos.top,
        left: pos.left,
        transform: side === 'right' ? 'translateY(-50%)' : side === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
      }}
    >
      <div
        className={`px-2 py-1 rounded-md text-xs font-medium border border-white/10 shadow-lg ${maxWidth ? 'whitespace-normal' : 'whitespace-nowrap'}`}
        style={{
          backgroundColor: bgColor ?? '#1a1a2e',
          color: textColor ?? '#e0e0e8',
          ...(maxWidth ? { maxWidth } : {}),
        }}
      >
        {text}
      </div>
    </div>
  ) : null

  return (
    <>
      <div ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} className="contents">
        {children}
      </div>
      {tooltip && createPortal(tooltip, document.body)}
    </>
  )
}
