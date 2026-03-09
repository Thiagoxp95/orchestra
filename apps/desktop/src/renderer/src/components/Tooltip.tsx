import { useState, useRef, useCallback, type ReactNode } from 'react'

interface TooltipProps {
  text: string
  children: ReactNode
  side?: 'right' | 'bottom'
  delay?: number
}

export function Tooltip({ text, children, side = 'right', delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const triggerRef = useRef<HTMLDivElement>(null)

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        if (side === 'right') {
          setPos({ top: rect.top + rect.height / 2, left: rect.right + 8 })
        } else {
          setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 })
        }
      }
      setVisible(true)
    }, delay)
  }, [delay, side])

  const hide = useCallback(() => {
    clearTimeout(timerRef.current)
    setVisible(false)
  }, [])

  return (
    <>
      <div ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} className="contents">
        {children}
      </div>
      {visible && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{
            top: pos.top,
            left: pos.left,
            transform: side === 'right' ? 'translateY(-50%)' : 'translateX(-50%)',
          }}
        >
          <div className="px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap bg-[#1a1a2e] text-[#e0e0e8] border border-white/10 shadow-lg">
            {text}
          </div>
        </div>
      )}
    </>
  )
}
