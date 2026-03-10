import { describe, expect, it } from 'vitest'
import { getCodexWatchRegistrationDecision } from './codex-watch-registration'

describe('getCodexWatchRegistrationDecision', () => {
  it('does not prime work state for a newly watched session', () => {
    expect(getCodexWatchRegistrationDecision(null, {
      cwd: '/repo',
      codexPid: 101,
    })).toEqual({
      shouldPrimeWorkState: false,
      shouldResetBinding: false,
    })
  })

  it('does not re-prime or reset for duplicate registrations', () => {
    expect(getCodexWatchRegistrationDecision({
      cwd: '/repo',
      codexPid: 101,
    }, {
      cwd: '/repo',
      codexPid: 101,
    })).toEqual({
      shouldPrimeWorkState: false,
      shouldResetBinding: false,
    })
  })

  it('resets when the codex pid changes', () => {
    expect(getCodexWatchRegistrationDecision({
      cwd: '/repo',
      codexPid: 101,
    }, {
      cwd: '/repo',
      codexPid: 202,
    })).toEqual({
      shouldPrimeWorkState: false,
      shouldResetBinding: true,
    })
  })

  it('resets when the cwd changes', () => {
    expect(getCodexWatchRegistrationDecision({
      cwd: '/repo-a',
      codexPid: 101,
    }, {
      cwd: '/repo-b',
      codexPid: 101,
    })).toEqual({
      shouldPrimeWorkState: false,
      shouldResetBinding: true,
    })
  })

  it('does not reset when a duplicate registration omits the pid', () => {
    expect(getCodexWatchRegistrationDecision({
      cwd: '/repo',
      codexPid: 101,
    }, {
      cwd: '/repo',
    })).toEqual({
      shouldPrimeWorkState: false,
      shouldResetBinding: false,
    })
  })
})
