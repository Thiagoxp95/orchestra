import type { CSSProperties } from 'react'
import { DynamicIcon } from './DynamicIcon'

const RING_DISTANCES: number[][] = [
  [4, 3, 2, 3, 4],
  [3, 2, 1, 2, 3],
  [2, 1, 0, 1, 2],
  [3, 2, 1, 2, 3],
  [4, 3, 2, 3, 4],
]

interface Props {
  icon: string
  size?: number
  color?: string
  working: boolean
}

export function AgentIconMorph({ icon, size = 18, color, working }: Props) {
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
          <span
            key={i}
            className="dmx-morph-dot"
            style={{ '--dmx-ring': ring } as CSSProperties}
          />
        ))}
      </span>
    </span>
  )
}
