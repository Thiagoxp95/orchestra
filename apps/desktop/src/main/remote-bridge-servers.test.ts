import { describe, expect, it } from 'vitest'
import type { RunningServer } from '../shared/types'
import { serversFingerprint, toMirroredServers } from './remote-bridge-servers'

const LOCAL: RunningServer[] = [
  {
    id: '900:3000',
    pid: 900,
    port: 3000,
    sessionId: 'session-a',
    command: 'node /Users/me/repo/node_modules/.bin/vite dev --port 3000',
    cwd: '/Users/me/repo/apps/web',
    kind: 'vite',
    name: 'web',
    urls: {
      local: 'http://localhost:3000',
      lan: 'http://192.168.1.42:3000',
      tailnet: 'http://tedys-mac.tail1.ts.net:3000',
      remote: 'http://tedys-mac.tail1.ts.net:3000',
    },
  },
  {
    id: '901:8081',
    pid: 901,
    port: 8081,
    sessionId: 'session-a',
    command: 'expo start',
    cwd: '/Users/me/repo/apps/mobile',
    kind: 'expo',
    name: 'mobile',
    urls: {
      local: 'http://localhost:8081',
      remote: 'http://tedys-mac.tail1.ts.net:8081',
      deepLink: 'exp://tedys-mac.tail1.ts.net:8081',
    },
  },
]

describe('toMirroredServers', () => {
  it('sends the URL a phone can open, never localhost', () => {
    const mirrored = toMirroredServers(LOCAL)
    expect(mirrored[0].url).toBe('http://tedys-mac.tail1.ts.net:3000')
    expect(JSON.stringify(mirrored)).not.toContain('localhost')
  })

  it('drops the command line and cwd — they name paths on the desktop', () => {
    const mirrored = toMirroredServers(LOCAL)
    expect(mirrored[0]).not.toHaveProperty('command')
    expect(mirrored[0]).not.toHaveProperty('cwd')
    expect(JSON.stringify(mirrored)).not.toContain('/Users/me')
  })

  it('keeps what a remote row renders and acts on', () => {
    expect(toMirroredServers(LOCAL)[0]).toEqual({
      id: '900:3000',
      sessionId: 'session-a',
      pid: 900,
      port: 3000,
      name: 'web',
      kind: 'vite',
      url: 'http://tedys-mac.tail1.ts.net:3000',
    })
  })

  it('carries the Expo deep link only where there is one', () => {
    const mirrored = toMirroredServers(LOCAL)
    expect(mirrored[0].deepLink).toBeUndefined()
    expect(mirrored[1].deepLink).toBe('exp://tedys-mac.tail1.ts.net:8081')
  })
})

describe('serversFingerprint', () => {
  it('is stable for an unchanged list, so an idle push writes nothing', () => {
    expect(serversFingerprint(toMirroredServers(LOCAL))).toBe(
      serversFingerprint(toMirroredServers(LOCAL)),
    )
  })

  it('moves when a server dies', () => {
    expect(serversFingerprint(toMirroredServers(LOCAL))).not.toBe(
      serversFingerprint(toMirroredServers(LOCAL.slice(0, 1))),
    )
  })
})
