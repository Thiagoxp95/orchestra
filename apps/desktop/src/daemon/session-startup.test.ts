import { describe, expect, it } from 'vitest'
import {
  buildShellEnvBootstrapCommand,
  canSendInitialCommand,
  getClaimDimensions,
  getResumeInitialCommand,
  getShellSpawnArgs,
} from './session'
import {
  CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
} from '../shared/action-utils'

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
    })).toBe("export ORCHESTRA_SESSION_ID='session-123'")
  })

  it('shell-quotes values safely', () => {
    expect(buildShellEnvBootstrapCommand({
      ORCHESTRA_SESSION_ID: "session-'quoted'",
    })).toBe("export ORCHESTRA_SESSION_ID='session-'\\''quoted'\\'''")
  })
})

describe('getClaimDimensions', () => {
  it('keeps a reused warm agent at its current PTY size until a real client attaches', () => {
    expect(
      getClaimDimensions(
        true,
        { cols: 180, rows: 42 },
        { cols: 120, rows: 30 }
      )
    ).toEqual({ cols: 120, rows: 30 })
  })

  it('resizes fresh sessions immediately to the requested viewport', () => {
    expect(
      getClaimDimensions(
        false,
        { cols: 180, rows: 42 },
        { cols: 120, rows: 30 }
      )
    ).toEqual({ cols: 180, rows: 42 })
  })
})

describe('getResumeInitialCommand', () => {
  it('drops a one-shot Claude prompt when resuming an interactive agent session', () => {
    expect(
      getResumeInitialCommand(`${CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW} 'fix the flaky test'`)
    ).toBe(CLAUDE_INTERACTIVE_SHELL_COMMAND_PREVIEW)
  })

  it('drops a one-shot Codex prompt when resuming an interactive agent session', () => {
    expect(
      getResumeInitialCommand(`${CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW} 'summarize this repo'`)
    ).toBe(CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW)
  })

  it('keeps non-agent commands unchanged', () => {
    expect(getResumeInitialCommand('npm test')).toBe('npm test')
  })
})
