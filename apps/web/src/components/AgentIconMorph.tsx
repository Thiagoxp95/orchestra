'use client'
import type { CSSProperties } from 'react'
import { DynamicIcon } from './DynamicIcon'

// The desktop's working-agent icon, ported (see AgentIconMorph in the renderer
// and .dmx-morph in globals.css). While an agent works its icon gives way to a
// field of dots that pulse outward from the middle; each dot is told which ring
// it sits on, and the CSS staggers both its entrance and its blink from that —
// so the bloom reads as one wave rather than twenty-five blinking dots.

const RING_DISTANCES: number[][] = [
  [4, 3, 2, 3, 4],
  [3, 2, 1, 2, 3],
  [2, 1, 0, 1, 2],
  [3, 2, 1, 2, 3],
  [4, 3, 2, 3, 4],
]

export function AgentIconMorph({
  icon,
  size = 18,
  color,
  working,
}: {
  icon: string
  size?: number
  color?: string
  working: boolean
}) {
  return (
    <span
      className="dmx-morph"
      data-working={working ? 'true' : 'false'}
      style={{ width: size, height: size, color } as CSSProperties}
    >
      <span className="dmx-morph-icon">
        <DynamicIcon name={icon} size={size} color={color} />
      </span>
      <span className="dmx-morph-grid" aria-hidden="true">
        {RING_DISTANCES.flat().map((ring, i) => (
          <span key={i} className="dmx-morph-dot" style={{ '--dmx-ring': ring } as CSSProperties} />
        ))}
      </span>
    </span>
  )
}
