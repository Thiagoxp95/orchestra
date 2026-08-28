import { describe, expect, it } from 'vitest'
import {
  buildServerUrls,
  collectDescendants,
  collectRunningServers,
  dedupeListeners,
  describeServer,
  detectKind,
  parseLsofListeners,
  parsePsRows,
  pickAddresses,
  resolveOwnerSession,
  buildParentMap,
} from './running-servers'

const LSOF = ['p900', 'n*:3000', 'p900', 'n[::1]:3000', 'p901', 'n127.0.0.1:8081', 'pnope', 'n*:1'].join('\n')

const PS = [
  '  100     1 /bin/zsh -l',
  '  200   100 node /repo/node_modules/.bin/turbo run dev',
  '  900   200 next-server (v15.0.0)',
  '  901   200 node /repo/apps/mobile/node_modules/expo/bin/cli start',
  '  999     1 /usr/sbin/httpd',
].join('\n')

describe('parseLsofListeners', () => {
  it('reads pid/host/port out of lsof field output', () => {
    expect(parseLsofListeners(LSOF)).toEqual([
      { pid: 900, port: 3000, host: '*' },
      { pid: 900, port: 3000, host: '::1' },
      { pid: 901, port: 8081, host: '127.0.0.1' },
    ])
  })

  it('ignores name lines with no pid and unparsable pids', () => {
    expect(parseLsofListeners('n*:3000\npbad\nn*:4000')).toEqual([])
  })
})

describe('dedupeListeners', () => {
  it('collapses the IPv4/IPv6 pair to one row, keeping the wildcard bind', () => {
    const deduped = dedupeListeners(parseLsofListeners(LSOF))
    expect(deduped).toEqual([
      { pid: 900, port: 3000, host: '*' },
      { pid: 901, port: 8081, host: '127.0.0.1' },
    ])
  })

  it('upgrades a loopback row when a wildcard bind for the same pid+port follows', () => {
    expect(dedupeListeners([
      { pid: 5, port: 80, host: '127.0.0.1' },
      { pid: 5, port: 80, host: '0.0.0.0' },
    ])).toEqual([{ pid: 5, port: 80, host: '0.0.0.0' }])
  })

  it('keeps the same port bound by two different processes', () => {
    expect(dedupeListeners([
      { pid: 5, port: 80, host: '*' },
      { pid: 6, port: 80, host: '*' },
    ])).toHaveLength(2)
  })
})

describe('parsePsRows', () => {
  it('splits pid/ppid off the front and keeps the whole command', () => {
    const rows = parsePsRows(PS)
    expect(rows).toHaveLength(5)
    expect(rows[1]).toEqual({ pid: 200, ppid: 100, command: 'node /repo/node_modules/.bin/turbo run dev' })
  })

  it('skips blank and malformed lines', () => {
    expect(parsePsRows('\n   \nnot a process row\n')).toEqual([])
  })
})

describe('resolveOwnerSession', () => {
  const parentMap = buildParentMap(parsePsRows(PS))
  const sessionPidToId = new Map([[100, 'session-a']])

  it('walks up through turbo to the session shell', () => {
    expect(resolveOwnerSession(900, parentMap, sessionPidToId)).toBe('session-a')
  })

  it('returns null for a process no session started', () => {
    expect(resolveOwnerSession(999, parentMap, sessionPidToId)).toBeNull()
  })

  it('matches the session shell itself', () => {
    expect(resolveOwnerSession(100, parentMap, sessionPidToId)).toBe('session-a')
  })
})

describe('collectDescendants', () => {
  it('lists the whole subtree deepest-first', () => {
    const order = collectDescendants(100, parsePsRows(PS))
    expect(order).toEqual([900, 901, 200])
    expect(order.indexOf(900)).toBeLessThan(order.indexOf(200))
  })

  it('is empty for a leaf', () => {
    expect(collectDescendants(900, parsePsRows(PS))).toEqual([])
  })
})

describe('detectKind', () => {
  it.each([
    ['node /repo/apps/mobile/node_modules/expo/bin/cli start', 'expo'],
    ['next-server (v15.0.0)', 'next'],
    ['node /repo/node_modules/.bin/vite --host', 'vite'],
    ['node /repo/node_modules/convex/bin/main.js dev', 'convex'],
    ['/usr/bin/python3 -m uvicorn app:main', 'python'],
    ['/usr/sbin/httpd -D FOREGROUND', 'server'],
  ])('%s -> %s', (command, kind) => {
    expect(detectKind(command)).toBe(kind)
  })
})

describe('describeServer', () => {
  it('names a server after the app directory it runs in', () => {
    expect(describeServer('next-server (v15)', '/repo/apps/web', 'next')).toBe('web')
  })

  it('falls back to the kind when the cwd is unknown', () => {
    expect(describeServer('next-server (v15)', undefined, 'next')).toBe('next')
  })

  it('falls back to the executable basename for an unrecognised server', () => {
    expect(describeServer('/usr/sbin/httpd -D FOREGROUND', undefined, 'server')).toBe('httpd')
  })
})

describe('pickAddresses', () => {
  it('separates the tailnet address from the LAN one and skips loopback', () => {
    expect(pickAddresses({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as never],
      utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false } as never],
    })).toEqual({ lan: '192.168.1.42', tailnet: '100.101.102.103' })
  })

  it('does not mistake a plain 100.x LAN address for a tailnet one', () => {
    expect(pickAddresses({
      en0: [{ address: '100.20.30.40', family: 'IPv4', internal: false } as never],
    })).toEqual({ lan: '100.20.30.40' })
  })
})

describe('buildServerUrls', () => {
  it('offers localhost, LAN and tailnet variants', () => {
    expect(buildServerUrls(3000, 'next', { lan: '192.168.1.42', tailnet: '100.101.102.103' })).toEqual({
      local: 'http://localhost:3000',
      lan: 'http://192.168.1.42:3000',
      tailnet: 'http://100.101.102.103:3000',
    })
  })

  it('adds an exp:// deep link on the tailnet host for expo', () => {
    expect(buildServerUrls(8081, 'expo', { lan: '192.168.1.42', tailnet: '100.101.102.103' }).deepLink)
      .toBe('exp://100.101.102.103:8081')
  })

  it('falls back to the LAN host for expo when there is no tailnet', () => {
    expect(buildServerUrls(8081, 'expo', { lan: '192.168.1.42' }).deepLink).toBe('exp://192.168.1.42:8081')
  })
})

describe('collectRunningServers', () => {
  it('attributes every port to the session that started it, labelled and sorted', () => {
    const servers = collectRunningServers({
      sessionPidToId: new Map([[100, 'session-a']]),
      listeners: parseLsofListeners(LSOF).concat({ pid: 999, port: 8080, host: '*' }),
      rows: parsePsRows(PS),
      cwdByPid: new Map([[900, '/repo/apps/web'], [901, '/repo/apps/mobile']]),
      addrs: { lan: '192.168.1.42', tailnet: '100.101.102.103' },
    })

    expect(servers.map((s) => [s.port, s.name, s.kind, s.sessionId])).toEqual([
      [3000, 'web', 'next', 'session-a'],
      [8081, 'mobile', 'expo', 'session-a'],
    ])
    expect(servers[1].urls.deepLink).toBe('exp://100.101.102.103:8081')
    expect(servers[0].id).toBe('900:3000')
  })

  it('drops ports owned by processes outside every session tree', () => {
    expect(collectRunningServers({
      sessionPidToId: new Map([[100, 'session-a']]),
      listeners: [{ pid: 999, port: 8080, host: '*' }],
      rows: parsePsRows(PS),
      cwdByPid: new Map(),
      addrs: {},
    })).toEqual([])
  })
})
