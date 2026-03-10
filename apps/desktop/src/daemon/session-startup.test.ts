import { describe, expect, it } from 'vitest'
import { getShellSpawnArgs } from './session'

describe('getShellSpawnArgs', () => {
  it('uses a non-login shell by default on macOS for faster startup', () => {
    expect(getShellSpawnArgs('darwin', {})).toEqual([])
  })

  it('keeps the old login-shell mode behind an env override', () => {
    expect(getShellSpawnArgs('darwin', { ORCHESTRA_LOGIN_SHELL: '1' })).toEqual(['-l'])
  })

  it('does not use login-shell flags on non-macOS platforms', () => {
    expect(getShellSpawnArgs('linux', { ORCHESTRA_LOGIN_SHELL: '1' })).toEqual([])
  })
})
