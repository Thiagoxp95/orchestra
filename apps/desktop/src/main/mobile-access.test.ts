import { describe, expect, it } from 'vitest'
import { buildMobileAccess, MOBILE_WEB_PORT } from './mobile-access'

describe('buildMobileAccess', () => {
  it('builds the Serve URL from the MagicDNS name', () => {
    const access = buildMobileAccess('mac.example.ts.net', true)
    expect(access.url).toBe(`https://mac.example.ts.net:${MOBILE_WEB_PORT}`)
    expect(access.host).toBe('mac.example.ts.net')
    expect(access.problem).toBeNull()
  })

  it('reports no URL when Tailscale is not running', () => {
    const access = buildMobileAccess(undefined, true)
    expect(access.url).toBeNull()
    expect(access.problem).toMatch(/Tailscale is not running/)
  })

  // Serve cannot issue an HTTPS certificate without MagicDNS, so a bare
  // hostname would produce a URL the phone refuses to load.
  it('refuses a non-MagicDNS hostname', () => {
    const access = buildMobileAccess('mac.local', true)
    expect(access.url).toBeNull()
    expect(access.host).toBe('mac.local')
    expect(access.problem).toMatch(/MagicDNS/)
  })

  // The URL is still correct — worth showing so the user can fix the cause
  // rather than wondering why the QR leads nowhere.
  it('still returns the URL when the web app is not being served, with a warning', () => {
    const access = buildMobileAccess('mac.example.ts.net', false)
    expect(access.url).toBe(`https://mac.example.ts.net:${MOBILE_WEB_PORT}`)
    expect(access.problem).toMatch(/Restart Orchestra/)
  })
})
