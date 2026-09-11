import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.stubGlobal('window', { electronAPI: {} })
vi.mock('../hooks/useTerminal', () => ({ useTerminal: () => ({ current: null }) }))
import { TerminalInstance } from './TerminalInstance'
describe('agent terminal surface', () => {
  it('exposes image picking on an active terminal pane', () => {
    const html = renderToStaticMarkup(<TerminalInstance sessionId="agent" cwd="/repo" isActive />)
    expect(html).toContain('aria-label="Attach image"')
    expect(html).toContain('type="file" accept="image/*"')
  })
})
