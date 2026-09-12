import { expect, test } from 'vitest'
import { relayConfig } from './config'

test('binds exclusively to loopback and requires a private phone origin', () => {
  expect(relayConfig({ ALLOWED_ORIGINS: 'https://mac.example.ts.net:8445' })).toMatchObject({ host: '127.0.0.1', port: 18080 })
  expect(() => relayConfig({ ALLOWED_ORIGINS: 'https://public.example.com' })).toThrow(/Tailscale/)
  expect(() => relayConfig({ ALLOWED_ORIGINS: 'https://mac.example.ts.net.evil.com' })).toThrow(/Tailscale/)
  expect(() => relayConfig({ ALLOWED_ORIGINS: '' })).toThrow()
  expect(() => relayConfig({ ALLOWED_ORIGINS: 'http://mac.example.ts.net' })).toThrow()
})

test('rejects malformed origins and invalid ports before listening', () => {
  for (const origin of ['https://mac.example.ts.net/path', 'https://user:pass@mac.example.ts.net', '*']) {
    expect(() => relayConfig({ ALLOWED_ORIGINS: origin })).toThrow()
  }
  for (const port of ['0', 'NaN', '65536', '123.5']) {
    expect(() => relayConfig({ ALLOWED_ORIGINS: 'https://mac.example.ts.net', PORT: port })).toThrow()
  }
})
