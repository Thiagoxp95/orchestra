import { describe, expect, it } from 'vitest'
import { buildShellEnvBootstrapCommand, canSendInitialCommand, getShellSpawnArgs } from './session'

describe('getShellSpawnArgs', () => {
  it('uses a non-login shell by default on macOS for faster startup', () => {
    expect(getShellSpawnArgs('/bin/zsh', 'darwin', {})).toEqual(['-i'])
  })

  it('keeps the old login-shell mode behind an env override', () => {
    expect(getShellSpawnArgs('/bin/zsh', 'darwin', { ORCHESTRA_LOGIN_SHELL: '1' })).toEqual(['-i', '-l'])
  })

  it('still forces interactive startup on non-macOS shells', () => {
    expect(getShellSpawnArgs('/bin/zsh', 'linux', { ORCHESTRA_LOGIN_SHELL: '1' })).toEqual(['-i', '-l'])
  })

  it('does not pass shell flags on Windows', () => {
    expect(getShellSpawnArgs('cmd.exe', 'win32', { ORCHESTRA_LOGIN_SHELL: '1' })).toEqual([])
  })
})

describe('canSendInitialCommand', () => {
  it('waits for shell output before sending shell commands', () => {
    expect(canSendInitialCommand({ kind: 'shell' }, 123, false)).toBe(false)
  })

  it('sends immediately once a warm shell is ready', () => {
    expect(canSendInitialCommand({ kind: 'shell' }, 123, true)).toBe(true)
  })

  it('never sends before the PTY exists', () => {
    expect(canSendInitialCommand({ kind: 'shell' }, null, true)).toBe(false)
  })

  it('allows direct exec launches as soon as the PTY is spawned', () => {
    expect(canSendInitialCommand({ kind: 'exec', file: 'claude' }, 123, false)).toBe(true)
  })
})

describe('buildShellEnvBootstrapCommand', () => {
  it('exports the claimed session env into a reused warm shell', () => {
    expect(buildShellEnvBootstrapCommand({
      ORCHESTRA_SESSION_ID: 'session-123',
      ORCHESTRA_HOOK_PORT: '4567',
    })).toBe("export ORCHESTRA_HOOK_PORT='4567'; export ORCHESTRA_SESSION_ID='session-123'")
  })

  it('shell-quotes values safely', () => {
    expect(buildShellEnvBootstrapCommand({
      ORCHESTRA_SESSION_ID: "session-'quoted'",
    })).toBe("export ORCHESTRA_SESSION_ID='session-'\\''quoted'\\'''")
  })
})
