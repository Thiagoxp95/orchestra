import { describe, it, expect } from 'vitest'
import { buildLiveStatus } from './remote-bridge-livestatus'

describe('buildLiveStatus', () => {
  it('shimmers a working session the daemon tap never caught (the bug)', () => {
    // Session is working per the renderer but absent from the sparse tap.
    const out = buildLiveStatus(['s1'], {}, { s1: 'working' })
    expect(out.s1).toEqual({ work: 'working' })
  })

  it('emits an entry for every live session, defaulting to idle', () => {
    const out = buildLiveStatus(['a', 'b'], {}, {})
    expect(out).toEqual({ a: { work: 'idle' }, b: { work: 'idle' } })
  })

  it('lets renderer work override a stale tap value', () => {
    const out = buildLiveStatus(['s1'], { s1: { work: 'working' } }, { s1: 'idle' })
    expect(out.s1.work).toBe('idle')
  })

  it('preserves the tap exited/label flags (exited must not shimmer)', () => {
    const out = buildLiveStatus(
      ['s1'],
      { s1: { work: 'idle', exited: true, label: 'B' } },
      { s1: 'working' },
    )
    // work reflects the renderer, but exited is kept so the web (work==='working'
    // && !exited) does not shimmer an exited session.
    expect(out.s1).toEqual({ work: 'working', exited: true, label: 'B' })
  })

  it('drops sessions no longer present (not in sessionIds)', () => {
    const out = buildLiveStatus(['s1'], { gone: { work: 'working' } }, { gone: 'working' })
    expect(out).toEqual({ s1: { work: 'idle' } })
  })

  it('falls back to the tap work when the renderer has no entry', () => {
    const out = buildLiveStatus(['s1'], { s1: { work: 'working' } }, {})
    expect(out.s1.work).toBe('working')
  })

  it('carries the context window figures for the phone overview', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      { s1: 'working' },
      {},
      { s1: { usedTokens: 98_883, contextWindow: 200_000, updatedAt: 1_700 } },
    )
    expect(out.s1).toEqual({
      work: 'working',
      contextTokens: 98_883,
      contextWindow: 200_000,
      activeAt: 1_700,
    })
  })

  it('carries the last-message stamp the overview sorts on, separately from the mtime', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      { s1: { usedTokens: 10, contextWindow: 200_000, updatedAt: 5_000, lastUserAt: 1_000 } },
    )
    expect(out.s1.activeAt).toBe(5_000)
    expect(out.s1.lastUserAt).toBe(1_000)
  })

  it('omits lastUserAt for an agent nobody has spoken to yet', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      { s1: { usedTokens: 10, contextWindow: 200_000, updatedAt: 5_000 } },
    )
    expect(out.s1).not.toHaveProperty('lastUserAt')
  })

  it('carries the current model and effort for the phone picker', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      {
        s1: {
          usedTokens: 10,
          contextWindow: 200_000,
          updatedAt: 1_700,
          model: 'claude-fable-5',
          effort: 'xhigh',
        },
      },
    )
    expect(out.s1.model).toBe('claude-fable-5')
    expect(out.s1.effort).toBe('xhigh')
  })

  // The bug: a session mirrors no model/effort until its first turn writes a
  // transcript, so the phone's picker showed two blank pills on every agent the
  // user had just opened. The launch flags say what it is running.
  it('falls back to the launch flags before the first turn', () => {
    const out = buildLiveStatus(['s1'], {}, {}, {}, {}, {}, {}, () => '', {
      s1: 'claude --model opus --effort high --dangerously-skip-permissions',
    })
    expect(out.s1.model).toBe('opus')
    expect(out.s1.effort).toBe('high')
  })

  it('lets the transcript override the launch flags (a /model switch)', () => {
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      {
        s1: {
          usedTokens: 10,
          contextWindow: 200_000,
          updatedAt: 1_700,
          model: 'claude-sonnet-5',
          effort: 'max',
        },
      },
      {},
      {},
      () => '',
      { s1: 'claude --model opus --effort high' },
    )
    expect(out.s1.model).toBe('claude-sonnet-5')
    expect(out.s1.effort).toBe('max')
  })

  it('fills only the half the transcript is missing', () => {
    // codex opens a turn with model+effort together, but claude's effort field
    // is absent on older transcripts — half a pair must still be completed.
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      { s1: { usedTokens: 10, contextWindow: 200_000, updatedAt: 1_700, model: 'claude-fable-5' } },
      {},
      {},
      () => '',
      { s1: 'claude --model opus --effort high' },
    )
    expect(out.s1.model).toBe('claude-fable-5')
    expect(out.s1.effort).toBe('high')
  })

  it('says nothing about a shell with no flags to read', () => {
    const out = buildLiveStatus(['shell'], {}, {}, {}, {}, {}, {}, () => '', { shell: 'zsh' })
    expect(out.shell).not.toHaveProperty('model')
    expect(out.shell).not.toHaveProperty('effort')
  })

  it('leaves a shell without context figures', () => {
    const out = buildLiveStatus(['shell'], {}, {}, {}, {}, { shell: 900 })
    expect(out.shell).toEqual({ work: 'idle', activeAt: 900 })
  })

  it('dates an agent by its transcript, never by terminal output', () => {
    // The bug: every PTY repaints when a phone claims geometry and resizes them
    // all, so `lastOutputAt` jumps to now for sessions the agent hasn't touched
    // in an hour. The transcript is the agent's own record — it wins even when
    // the terminal printed a second ago.
    const out = buildLiveStatus(
      ['s1'],
      {},
      {},
      {},
      { s1: { usedTokens: 10, contextWindow: 200_000, updatedAt: 1_000 } },
      { s1: 2_000 },
    )
    expect(out.s1.activeAt).toBe(1_000)
  })

  it('falls back to terminal output only when there is no transcript', () => {
    const out = buildLiveStatus(['s1'], {}, {}, {}, {}, { s1: 2_000 })
    expect(out.s1.activeAt).toBe(2_000)
  })

  it('omits activeAt entirely when neither clock has seen the session', () => {
    const out = buildLiveStatus(['s1'], {}, {})
    expect(out.s1).not.toHaveProperty('activeAt')
  })

  // The phone withholds its chat view on a false, and keeps it on a MISSING
  // field (a desktop too old to publish the flag) — so an agent whose
  // transcript hasn't paired must be stamped false out loud, and a shell must
  // carry nothing at all.
  it('publishes chat readiness for agents and says nothing about shells', () => {
    const out = buildLiveStatus(['agent', 'pending', 'shell'], {}, {}, {}, {}, {}, {
      agent: true,
      pending: false,
    })
    expect(out.agent.chatReady).toBe(true)
    expect(out.pending.chatReady).toBe(false)
    expect(out.shell).not.toHaveProperty('chatReady')
  })

  // A live folder-trust / permission prompt scraped off the screen rides on the
  // entry so the phone can card it — but only for an agent session (one the tap
  // knows) that hasn't exited.
  const TRUST_SCREEN =
    'Quick safety check: Is this a project you created or one you trust? ' +
    '❯ 1. Yes, I trust this folder 2. No, exit Enter to confirm · Esc to cancel'

  it('attaches a scraped TUI prompt for a live agent session', () => {
    const out = buildLiveStatus(
      ['s1'],
      { s1: { work: 'idle' } },
      {},
      {},
      {},
      {},
      {},
      (id) => (id === 's1' ? TRUST_SCREEN : ''),
    )
    expect(out.s1.tuiPrompt?.kind).toBe('trust')
  })

  it('does not scrape a prompt for a shell (no tap entry) or an exited session', () => {
    const shell = buildLiveStatus(['shell'], {}, {}, {}, {}, {}, {}, () => TRUST_SCREEN)
    expect(shell.shell).not.toHaveProperty('tuiPrompt')
    const dead = buildLiveStatus(
      ['s1'],
      { s1: { work: 'idle', exited: true } },
      {},
      {},
      {},
      {},
      {},
      () => TRUST_SCREEN,
    )
    expect(dead.s1).not.toHaveProperty('tuiPrompt')
  })
})
