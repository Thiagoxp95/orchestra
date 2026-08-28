import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunningServer } from '../../../shared/types'
import { ServersGroup } from './ServersGroup'

const SERVERS: RunningServer[] = [
  {
    id: '900:3000',
    pid: 900,
    port: 3000,
    sessionId: 'session-a',
    command: 'next-server (v15)',
    cwd: '/repo/apps/web',
    kind: 'next',
    name: 'web',
    urls: { local: 'http://localhost:3000', lan: 'http://192.168.1.42:3000', tailnet: 'http://100.1.2.3:3000' },
  },
  {
    id: '901:8081',
    pid: 901,
    port: 8081,
    sessionId: 'session-a',
    command: 'expo start',
    cwd: '/repo/apps/mobile',
    kind: 'expo',
    name: 'mobile',
    urls: { local: 'http://localhost:8081', deepLink: 'exp://100.1.2.3:8081' },
  },
]

function render(servers: RunningServer[]): string {
  return renderToStaticMarkup(
    <ServersGroup
      servers={servers}
      wsColor="#4f46e5"
      txtColor="#ffffff"
      sessionLabel={() => 'Terminal 1'}
      onFocusSession={() => {}}
      onKilled={() => {}}
      onKillAll={() => {}}
    />,
  )
}

describe('ServersGroup', () => {
  it('renders nothing when the worktree has no servers', () => {
    expect(render([])).toBe('')
  })

  it('lists one row per server with its port and app name', () => {
    const html = render(SERVERS)
    expect(html).toContain('Servers')
    expect(html).toContain('>3000<')
    expect(html).toContain('>web<')
    expect(html).toContain('>8081<')
    expect(html).toContain('>mobile<')
  })

  it('shows the owning session and the URL in the row tooltip', () => {
    expect(render(SERVERS)).toContain('http://localhost:3000 · Terminal 1')
  })

  it('offers the Expo deep link only on the expo row', () => {
    const html = render(SERVERS)
    expect(html.match(/>exp</g)).toHaveLength(1)
  })

  it('shows a kill affordance per row', () => {
    const html = render(SERVERS)
    expect(html).toContain('Kill all')
    expect(html).toContain('free port 3000')
    expect(html).toContain('free port 8081')
  })
})
