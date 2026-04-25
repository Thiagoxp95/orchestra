import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { UsageSnapshot } from '../../../shared/types'

let mockedSnapshot: UsageSnapshot | null = null

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
    useRef: () => ({ current: 0 }),
    useState: () => [mockedSnapshot, vi.fn()],
  }
})

describe('UsageBadge', () => {
  it('keeps Claude visible when Codex has usage before Claude probe data arrives', async () => {
    mockedSnapshot = {
      claude: { probe: null, scan: null, isSyncing: false },
      codex: {
        probe: {
          provider: 'codex',
          session: { usedPercent: 2, resetsAt: null, resetText: null },
          weekly: { usedPercent: 42, resetsAt: null, resetText: null },
          error: null,
          updatedAt: 1_000,
        },
        scan: null,
        isSyncing: false,
      },
    }

    const { UsageBadge } = await import('./UsageBadge')
    const rendered = UsageBadge({
      wsColor: '#111111',
      textColor: '#eeeeee',
      onClick: vi.fn(),
    }) as ReactElement

    const button = rendered.props.children as ReactElement
    const providerSpans = button.props.children as ReactElement[]

    expect(providerSpans).toHaveLength(2)
    expect(providerSpans[0].key).toBe('__claude__')
    expect(providerSpans[1].key).toBe('__openai__')
  })
})
