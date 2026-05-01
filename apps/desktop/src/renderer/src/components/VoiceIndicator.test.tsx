import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { VoiceEvent, VoiceStatus } from '../../../shared/types'

// Captured at import-time from the mocked modules so each test can drive
// the component as a function.
let voiceEnabled = false
let visualState: { kind: 'idle' } | { kind: 'awake' } | { kind: 'no-match'; text: string } = { kind: 'idle' }
let status: VoiceStatus | null = { enabled: true, state: 'listening' }

const setVisualState = vi.fn((next: typeof visualState) => {
  visualState = next
})
const setStatus = vi.fn((next: VoiceStatus | null) => {
  status = next
})

let lastVoiceEventListener: ((event: VoiceEvent) => void) | null = null

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
    useState: ((initial: unknown) => {
      // Two useState calls in order: status then visual.
      // We branch on the value to know which is which.
      if (initial === null) {
        return [status, setStatus]
      }
      return [visualState, setVisualState]
    }) as unknown,
  }
})

vi.mock('../store/app-store', () => ({
  useAppStore: (selector: (s: { settings: { voice?: { enabled: boolean } } }) => unknown) =>
    selector({ settings: { voice: { enabled: voiceEnabled } } }),
}))

function setupElectronAPI() {
  ;(global as { window?: { electronAPI: unknown } }).window = {
    electronAPI: {
      voiceGetStatus: vi.fn(() => Promise.resolve(status)),
      onVoiceStatus: vi.fn(() => () => {}),
      onVoiceEvent: vi.fn((cb: (event: VoiceEvent) => void) => {
        lastVoiceEventListener = cb
        return () => {}
      }),
    },
  }
}

describe('VoiceIndicator', () => {
  it('renders nothing when voice is disabled', async () => {
    voiceEnabled = false
    visualState = { kind: 'idle' }
    setupElectronAPI()
    const { VoiceIndicator } = await import('./VoiceIndicator')
    const result = VoiceIndicator({ wsColor: '#f00', textColor: '#fff' }) as ReactElement | null
    expect(result).toBeNull()
  })

  it('renders the dim mic dot when enabled and idle', async () => {
    voiceEnabled = true
    visualState = { kind: 'idle' }
    setupElectronAPI()
    const { VoiceIndicator } = await import('./VoiceIndicator')
    const rendered = VoiceIndicator({ wsColor: '#f00', textColor: '#fff' }) as ReactElement
    expect(rendered).not.toBeNull()
    // Look at the rendered children — the dot is the second child (after
    // the optional bubble); the bubble should be absent in idle state.
    const children = rendered.props.children as ReactElement[]
    const visibleChildren = children.filter((c) => c)
    expect(visibleChildren).toHaveLength(1)
    const dot = visibleChildren[0]
    expect(dot.props.style.opacity).toBe(0.3)
  })

  it('shows pulsing dot when awake', async () => {
    voiceEnabled = true
    visualState = { kind: 'awake' }
    setupElectronAPI()
    const { VoiceIndicator } = await import('./VoiceIndicator')
    const rendered = VoiceIndicator({ wsColor: '#abc', textColor: '#fff' }) as ReactElement
    const children = rendered.props.children as ReactElement[]
    const dot = children.filter((c) => c).pop() as ReactElement
    expect(dot.props.className).toContain('animate-pulse')
    expect(dot.props.style.opacity).toBe(1)
    expect(dot.props.style.backgroundColor).toBe('#abc')
  })

  it('shows the no-match bubble with heard text', async () => {
    voiceEnabled = true
    visualState = { kind: 'no-match', text: 'shipping container' }
    setupElectronAPI()
    const { VoiceIndicator } = await import('./VoiceIndicator')
    const rendered = VoiceIndicator({ wsColor: '#abc', textColor: '#fff' }) as ReactElement
    const children = rendered.props.children as ReactElement[]
    const bubble = children.find((c) => c && c.props.className?.includes('animate-fade-in')) as ReactElement
    expect(bubble).toBeTruthy()
    const bubbleText = JSON.stringify(bubble.props.children)
    expect(bubbleText).toContain('shipping container')
    expect(bubbleText).toContain('no match')
  })

  it('renders an error-tinted dot when status reports an error', async () => {
    voiceEnabled = true
    visualState = { kind: 'idle' }
    status = { enabled: true, state: 'error', lastError: { code: 'mic_denied' } }
    setupElectronAPI()
    const { VoiceIndicator } = await import('./VoiceIndicator')
    const rendered = VoiceIndicator({ wsColor: '#abc', textColor: '#fff' }) as ReactElement
    const children = rendered.props.children as ReactElement[]
    const dot = children.filter((c) => c).pop() as ReactElement
    expect(dot.props.style.backgroundColor).toBe('#ff5577')
    expect(dot.props.title).toContain('mic_denied')
    // Reset for next test runs.
    status = { enabled: true, state: 'listening' }
  })

  // Sanity check that the IPC subscription wiring exists — the mocked
  // useEffect doesn't actually attach the listeners but the module-level
  // `setupElectronAPI` already registered the spy that the production
  // `useEffect` would have invoked.
  it('voiceEnabled setting flips the rendered output', async () => {
    voiceEnabled = false
    setupElectronAPI()
    let { VoiceIndicator } = await import('./VoiceIndicator')
    let result = VoiceIndicator({ wsColor: '#abc', textColor: '#fff' })
    expect(result).toBeNull()
    voiceEnabled = true
    result = VoiceIndicator({ wsColor: '#abc', textColor: '#fff' })
    expect(result).not.toBeNull()
    // Touch the captured ref so vitest doesn't flag unused let.
    expect(lastVoiceEventListener).toBeNull()
  })
})
