import { describe, expect, it } from 'vitest'
import { safeServers, serversForTree } from './servers'

const RAW = [
  { id: '900:3000', sessionId: 's1', pid: 900, port: 3000, name: 'web', kind: 'vite', url: 'http://mac.ts.net:3000' },
  { id: '901:8081', sessionId: 's2', pid: 901, port: 8081, name: 'mobile', kind: 'expo', url: 'http://mac.ts.net:8081', deepLink: 'exp://mac.ts.net:8081' },
]

describe('safeServers', () => {
  it('passes through well-formed rows', () => {
    expect(safeServers(RAW)).toHaveLength(2)
    expect(safeServers(RAW)[1].deepLink).toBe('exp://mac.ts.net:8081')
  })

  it('treats a desktop that never sent the field as no servers', () => {
    expect(safeServers(undefined)).toEqual([])
    expect(safeServers(null)).toEqual([])
    expect(safeServers('nope')).toEqual([])
  })

  it('skips rows missing the id, session, port or URL a row needs', () => {
    expect(
      safeServers([
        { id: 'x', sessionId: 's1', port: 3000 },
        { sessionId: 's1', port: 3000, url: 'http://x' },
        null,
        { id: 'y', sessionId: 's1', port: '3000', url: 'http://x' },
      ]),
    ).toEqual([])
  })

  it('falls back to the port as a name when the desktop sent none', () => {
    expect(safeServers([{ id: 'z', sessionId: 's1', port: 4321, url: 'http://x' }])[0].name).toBe('4321')
  })
})

describe('serversForTree', () => {
  it('keeps only the servers this worktree started, lowest port first', () => {
    expect(serversForTree(safeServers(RAW), ['s2', 's1']).map((s) => s.port)).toEqual([3000, 8081])
  })

  it('is empty for a worktree whose sessions run nothing', () => {
    expect(serversForTree(safeServers(RAW), ['s9'])).toEqual([])
  })
})
