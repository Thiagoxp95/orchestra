'use client'

/**
 * The destructive action's glyph, revealed behind a row or card swiped left.
 *
 * Drawn inline rather than pulled from the icon set because it is the one icon
 * that must never fail to render: it is the confirmation step of a kill, and a
 * missing glyph would leave an unlabelled red button.
 */
export function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M5 4l.5 9c0 .6.4 1 1 1h3c.6 0 1-.4 1-1L11 4M6.5 6.5v5M9.5 6.5v5" />
    </svg>
  )
}
