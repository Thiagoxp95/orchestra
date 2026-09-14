import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { UsageSnapshot } from '../../../shared/types'

let mockedSnapshot: UsageSnapshot | null = null

// The icon set is a 1.4 MB module; transforming it on the cold dynamic import
// below blew past the 5s test timeout. Icons render no text, so stub it.
vi.mock('./DynamicIcon', () => ({ DynamicIcon: () => null }))

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

// Walk the rendered tree and collect every rendered string, so assertions
// don't depend on where in the child array a segment lands.
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  const element = node as ReactElement
  if (element.props) collectText(element.props.children, out)
  return out
}

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

  it('renders each scoped Claude limit alongside session and weekly', async () => {
    mockedSnapshot = {
      claude: {
        probe: {
          provider: 'claude',
          session: { usedPercent: 1, resetsAt: null, resetText: null },
          weekly: { usedPercent: 72, resetsAt: null, resetText: null },
          scoped: [
            { label: 'Fable', usedPercent: 100, resetsAt: null, resetText: null, severity: 'critical', isActive: true },
          ],
          error: null,
          updatedAt: 1_000,
        },
        scan: null,
        isSyncing: false,
      },
      codex: { probe: null, scan: null, isSyncing: false },
    }

    const { UsageBadge } = await import('./UsageBadge')
    const rendered = UsageBadge({
      wsColor: '#111111',
      textColor: '#eeeeee',
      onClick: vi.fn(),
    }) as ReactElement

    const button = rendered.props.children as ReactElement
    const claudeSpan = (button.props.children as ReactElement[])[0]
    const text = collectText(claudeSpan).join('')

    expect(text).toContain('1%')
    expect(text).toContain('72%')
    expect(text).toContain('Fable')
    expect(text).toContain('100%')
    // The em-dash placeholder is only for a provider with no data at all.
    expect(text).not.toContain('—')
  })
})
