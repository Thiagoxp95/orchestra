import { describe, expect, it } from 'vitest'
import {
  buildShellEnvBootstrapCommand,
  canSendInitialCommand,
  consumeStartupMarker,
  getClaimDimensions,
  getResumeInitialCommand,
  getShellSpawnArgs,
  shouldSuppressShellStartupOutput,
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

describe('shouldSuppressShellStartupOutput', () => {
  it('suppresses a warm-up shell prompt while an agent CLI launch is pending', () => {
    expect(shouldSuppressShellStartupOutput({ kind: 'shell' }, false, true)).toBe(true)
  })

  it('forwards output once the shell is marked ready', () => {
    expect(shouldSuppressShellStartupOutput({ kind: 'shell' }, true, true)).toBe(false)
  })

  it('forwards output when there is nothing to inject (plain reattach)', () => {
    expect(shouldSuppressShellStartupOutput({ kind: 'shell' }, false, false)).toBe(false)
  })

  it('never suppresses output for direct exec launches', () => {
    expect(shouldSuppressShellStartupOutput({ kind: 'exec', file: 'claude' }, false, true)).toBe(false)
  })

  it('treats an undefined launch profile as a shell launch', () => {
    expect(shouldSuppressShellStartupOutput(undefined, false, true)).toBe(true)
  })
})

describe('consumeStartupMarker', () => {
  const marker = '\x1eORCH-READY-abc\x1e'

  it('drops all bytes before the marker and clears suppression after match', () => {
    const result = consumeStartupMarker(
      { marker, buffer: '' },
      `\x1b[?25l\ncmd echo garbage${marker}\x1b[H\x1b[2Jagent-ui-here`,
    )
    expect(result.data).toBe('\x1b[H\x1b[2Jagent-ui-here')
    expect(result.marker).toBeNull()
    expect(result.buffer).toBe('')
  })

  it('buffers partial marker at chunk boundary so it still matches on the next chunk', () => {
    const fullData = `prompt echo${marker}agent-ui`
    const split = 18
    const part1 = fullData.slice(0, split)
    const part2 = fullData.slice(split)

    const first = consumeStartupMarker({ marker, buffer: '' }, part1)
    expect(first.data).toBe('')
    expect(first.marker).toBe(marker)
    expect(first.buffer.length).toBeLessThanOrEqual(marker.length - 1)

    const second = consumeStartupMarker({ marker: first.marker, buffer: first.buffer }, part2)
    expect(second.data).toBe('agent-ui')
    expect(second.marker).toBeNull()
  })

  it('passes data through unchanged once the marker has been cleared', () => {
    const result = consumeStartupMarker({ marker: null, buffer: '' }, 'live output')
    expect(result.data).toBe('live output')
    expect(result.marker).toBeNull()
    expect(result.buffer).toBe('')
  })

  it('does not let a stray newline in a multi-line prompt clear suppression early', () => {
    // Simulates a SIGWINCH redraw from a powerlevel10k-style prompt that
    // contains an embedded newline. Marker-based suppression must ignore it.
    const redraw = '\x1b[2K\x1b[G╭─ ~/project\n╰─ %_'
    const result = consumeStartupMarker({ marker, buffer: '' }, redraw)
    expect(result.data).toBe('')
    expect(result.marker).toBe(marker)
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
