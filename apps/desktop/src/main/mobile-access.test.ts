import { describe, expect, it } from 'vitest'
import { buildMobileAccess, MOBILE_WEB_PORT, SERVE_TARGET } from './mobile-access'
import { parseServeRoute } from './tailscale'

const running = { installed: true, backendState: 'Running', dnsName: 'mac.example.ts.net' }
const published = { proxy: SERVE_TARGET, funnel: false }
const unpublished = { proxy: null, funnel: false }

describe('buildMobileAccess', () => {
  it('is ready with the Serve URL once everything is in place', () => {
    const access = buildMobileAccess({ tailscale: running, route: published, webServed: true })
    expect(access.step).toBe('ready')
    expect(access.url).toBe(`https://mac.example.ts.net:${MOBILE_WEB_PORT}`)
    expect(access.host).toBe('mac.example.ts.net')
    expect(access.problem).toBeNull()
  })

  it('asks to install Tailscale first', () => {
    const access = buildMobileAccess({
      tailscale: { installed: false, backendState: null, dnsName: null }, route: unpublished, webServed: true,
    })
    expect(access.step).toBe('install-tailscale')
    expect(access.url).toBeNull()
  })

  it('asks to open and sign in when installed but not running', () => {
    const access = buildMobileAccess({
      tailscale: { installed: true, backendState: 'NeedsLogin', dnsName: null }, route: unpublished, webServed: true,
    })
    expect(access.step).toBe('open-tailscale')
    expect(access.problem).toMatch(/sign in/)
  })

  // Serve cannot issue an HTTPS certificate without MagicDNS, so a bare
  // hostname would produce a URL the phone refuses to load.
  it('asks for MagicDNS when there is no ts.net name', () => {
    const access = buildMobileAccess({
      tailscale: { installed: true, backendState: 'Running', dnsName: null }, route: unpublished, webServed: true,
    })
    expect(access.step).toBe('enable-magicdns')
    expect(access.url).toBeNull()
  })

  it('offers to publish when Serve has no route yet', () => {
    const access = buildMobileAccess({ tailscale: running, route: unpublished, webServed: true })
    expect(access.step).toBe('publish')
    expect(access.published).toBe(false)
    expect(access.url).toBe(`https://mac.example.ts.net:${MOBILE_WEB_PORT}`)
    expect(access.problem).toBeNull()
  })

  it('refuses to publish over a port something else owns', () => {
    const access = buildMobileAccess({
      tailscale: running, route: { proxy: 'http://127.0.0.1:3000', funnel: false }, webServed: true,
    })
    expect(access.step).toBe('publish')
    expect(access.problem).toMatch(/already points at/)
  })

  it('refuses to publish while Funnel exposes the port publicly', () => {
    const access = buildMobileAccess({ tailscale: running, route: { proxy: SERVE_TARGET, funnel: true }, webServed: true })
    expect(access.step).toBe('publish')
    expect(access.problem).toMatch(/Funnel/)
  })

  // The URL is still correct — worth showing so the user can fix the cause
  // rather than wondering why the QR leads nowhere.
  it('still returns the URL when the local server is down, with a warning', () => {
    const access = buildMobileAccess({ tailscale: running, route: published, webServed: false })
    expect(access.step).toBe('ready')
    expect(access.url).toBe(`https://mac.example.ts.net:${MOBILE_WEB_PORT}`)
    expect(access.problem).toMatch(/Restart Orchestra/)
  })
})

describe('parseServeRoute', () => {
  const json = JSON.stringify({
    Web: {
      'mac.example.ts.net:8445': { Handlers: { '/': { Proxy: 'http://127.0.0.1:13000' } } },
      'mac.example.ts.net:8446': { Handlers: { '/': { Proxy: 'http://127.0.0.1:13210' } } },
    },
    AllowFunnel: { 'mac.example.ts.net:8446': true },
  })

  it('finds the proxy for our port only', () => {
    expect(parseServeRoute(json, 8445)).toEqual({ proxy: 'http://127.0.0.1:13000', funnel: false })
    expect(parseServeRoute(json, 8446)).toEqual({ proxy: 'http://127.0.0.1:13210', funnel: true })
    expect(parseServeRoute(json, 9999)).toEqual({ proxy: null, funnel: false })
  })

  it('treats non-JSON (Serve never configured) as no route', () => {
    expect(parseServeRoute('', 8445)).toEqual({ proxy: null, funnel: false })
  })
})
