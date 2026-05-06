import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chunkIndicatesCodexInterruptedPrompt,
  chunkIndicatesCodexPromptReady,
  clearAllCodexTerminalState,
  clearCodexTerminalState,
  feedCodexTerminalChunk,
} from './codex-terminal-state'

afterEach(() => {
  clearAllCodexTerminalState()
  vi.useRealTimers()
})

describe('chunkIndicatesCodexInterruptedPrompt', () => {
  it('recognizes Codex returning to the prompt after an interrupted conversation', () => {
    expect(chunkIndicatesCodexInterruptedPrompt(
      '■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.\r\n› Use /skills to list available skills',
    )).toBe(true)
  })

  it('ignores unrelated Codex terminal output', () => {
    expect(chunkIndicatesCodexInterruptedPrompt(
      'Thinking...\nRunning tests...\n',
    )).toBe(false)
  })
})

describe('chunkIndicatesCodexPromptReady', () => {
  it('recognizes Codex returning to the editable prompt with its status footer', () => {
    expect(chunkIndicatesCodexPromptReady(
      '• What’s something you used to enjoy but haven’t done in a while?\x07\n› Improve documentation in @filename\n  gpt-5.5 low · ~/Tedy/orchestra',
    )).toBe(true)
  })

  it('recognizes the prompt-ready footer even when Codex redraws merge the lines together', () => {
    // After ANSI/CSI cursor-positioning is stripped, codex's redraw can leave
    // the prompt input and the model footer on the same line with no newline
    // separating them. Slash commands like `/fast` reach this path because
    // they bypass the agent loop and never fire a Stop hook.
    expect(chunkIndicatesCodexPromptReady(
      '› Improve documentation in @filenamegpt-5.5 high fast · ~/Tedy/orchestra',
    )).toBe(true)
  })

  it('recognizes the footer even when extra spaces collapse where newlines used to be', () => {
    expect(chunkIndicatesCodexPromptReady(
      '› Improve documentation in @filename   gpt-5.5 high fast · ~/Tedy/orchestra',
    )).toBe(true)
  })

  it('ignores submitted prompt transcript lines without the Codex footer', () => {
    expect(chunkIndicatesCodexPromptReady(
      '› ask me something\n• What’s one thing you want to get done today?',
    )).toBe(false)
  })
})

describe('feedCodexTerminalChunk', () => {
  it('returns working when codex shows the live interruptible activity banner', () => {
    const sessionId = 'sess-working-signal'

    const signals = feedCodexTerminalChunk(
      sessionId,
      'Waiting for background terminal (10m 39s · esc to interrupt) · 1 background terminal running',
    )

    expect(signals.working).toBe(true)
    expect(signals.promptReady).toBe(false)
    expect(signals.interrupted).toBe(false)
  })

  it('returns promptReady once enough chunks have accumulated to span the signature', () => {
    const sessionId = 'sess-fragmented'

    const first = feedCodexTerminalChunk(sessionId, '› Improve documentation in @filename\n')
    expect(first.promptReady).toBe(false)

    const second = feedCodexTerminalChunk(sessionId, '  gpt-5.5 high fast · ~/Tedy/orchestra')
    expect(second.promptReady).toBe(true)
  })

  it('returns promptReady for an idle prompt with no typed text', () => {
    const signals = feedCodexTerminalChunk(
      'sess-empty-prompt',
      '› \n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )

    expect(signals.working).toBe(false)
    expect(signals.promptReady).toBe(true)
  })

  it('returns promptReady while editing a long pasted prompt', () => {
    const signals = feedCodexTerminalChunk(
      'sess-long-prompt',
      `› ${'x'.repeat(700)}\n  gpt-5.5 high fast · ~/Tedy/orchestra`,
    )

    expect(signals.working).toBe(false)
    expect(signals.promptReady).toBe(true)
  })

  it('does not treat typed text mentioning esc to interrupt as a working banner', () => {
    const signals = feedCodexTerminalChunk(
      'sess-typed-esc',
      '› Explain why the UI says esc to interrupt when Codex is idle\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )

    expect(signals.working).toBe(false)
    expect(signals.promptReady).toBe(true)
  })

  it('returns interrupted when the marker spans a chunk boundary', () => {
    const sessionId = 'sess-interrupted'

    const first = feedCodexTerminalChunk(sessionId, '■ Conversation int')
    expect(first.interrupted).toBe(false)

    const second = feedCodexTerminalChunk(sessionId, 'errupted - tell the model what to do differently.')
    expect(second.interrupted).toBe(true)
  })

  it('forgets a session when explicitly cleared so a stale tail does not match', () => {
    const sessionId = 'sess-cleared'

    feedCodexTerminalChunk(sessionId, '› Improve documentation in @filename\n')
    clearCodexTerminalState(sessionId)

    const after = feedCodexTerminalChunk(sessionId, '  gpt-5.5 high fast · ~/Tedy/orchestra')
    // Footer alone (no `›` input line) should not be enough to match.
    expect(after.promptReady).toBe(false)
  })

  it('only signals promptReady on the rising edge so a stale match does not yank state back to idle on every chunk', () => {
    // After the signature first matches, it lingers in the rolling buffer for
    // thousands of bytes. If we re-fired while UserPromptSubmit had just
    // transitioned us to working, the spinner would never stay on through a
    // real run.
    const sessionId = 'sess-rising-edge'

    const first = feedCodexTerminalChunk(
      sessionId,
      '› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(first.promptReady).toBe(true)

    const followUp = feedCodexTerminalChunk(sessionId, '\n')
    expect(followUp.promptReady).toBe(false)

    const moreNoise = feedCodexTerminalChunk(sessionId, 'tool output line\n')
    expect(moreNoise.promptReady).toBe(false)
  })

  it('re-fires promptReady when codex repaints the prompt after a slash command (the /fast scenario)', () => {
    // The user-reported bug: codex fires UserPromptSubmit for `/fast` (state
    // → working), processes the slash command client-side, never fires Stop,
    // and repaints the prompt. We need that repaint to push the spinner
    // back to idle.
    const sessionId = 'sess-slash-cmd'

    const initial = feedCodexTerminalChunk(
      sessionId,
      '› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(initial.promptReady).toBe(true)

    const slashCmdEcho = feedCodexTerminalChunk(sessionId, '\n› /fast\n')
    expect(slashCmdEcho.promptReady).toBe(false)

    const repaint = feedCodexTerminalChunk(
      sessionId,
      '\n• Fast mode set to on\n› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(repaint.promptReady).toBe(true)
  })

  it('re-fires promptReady after the signature drops out and reappears', () => {
    const sessionId = 'sess-reappear'

    const first = feedCodexTerminalChunk(
      sessionId,
      '› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(first.promptReady).toBe(true)

    // Flood the buffer so the prompt-ready tail scrolls out.
    const flooded = feedCodexTerminalChunk(sessionId, 'x'.repeat(8 * 1024))
    expect(flooded.promptReady).toBe(false)

    const reappeared = feedCodexTerminalChunk(
      sessionId,
      '› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(reappeared.promptReady).toBe(true)
  })

  it('keeps the rolling buffer bounded so a flood of output cannot drift the state forever', () => {
    const sessionId = 'sess-bounded'
    const filler = 'x'.repeat(8 * 1024)

    feedCodexTerminalChunk(sessionId, '› Improve documentation in @filename\n')
    const flooded = feedCodexTerminalChunk(sessionId, filler)
    // Once the prompt-input line scrolls out of the rolling window, the
    // buffer should no longer satisfy the prompt-ready signature on its own.
    expect(flooded.promptReady).toBe(false)

    const settled = feedCodexTerminalChunk(sessionId, '  gpt-5.5 high fast · ~/Tedy/orchestra')
    expect(settled.promptReady).toBe(false)
  })

  it('suppresses promptReady while codex is still showing the working banner', () => {
    // Repro of the "spinner never appears" bug: codex's working TUI contains
    // the typed prompt, the "Working (Xs · esc to interrupt)" banner, and the
    // model footer all at once. The PROMPT_READY pattern matches the typed
    // prompt + footer span, but codex is clearly NOT idle — firing here yanks
    // normalized state back to idle ~26ms after markRunStarted set it to
    // working, leaving the sidebar spinner permanently off through the run.
    const sessionId = 'sess-working-banner'

    const working = feedCodexTerminalChunk(
      sessionId,
      '› Run /review on my current changes\nWorking (9s · esc to interrupt)\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(working.promptReady).toBe(false)
  })

  it('fires promptReady once the working banner clears from the buffer and stops re-appearing', () => {
    // Once the turn finishes the banner stops being emitted and eventually
    // scrolls out. A subsequent prompt redraw without the banner — and after
    // enough wall-clock time has passed without seeing it again — must fire so
    // /fast-style runs (no Stop hook) still recover idle state.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const sessionId = 'sess-banner-clears'

    const duringWork = feedCodexTerminalChunk(
      sessionId,
      '› Run /review\nWorking (9s · esc to interrupt)\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(duringWork.promptReady).toBe(false)

    // Push enough output to scroll the working banner out of the rolling
    // buffer; advance time past the grace window; then send the prompt redraw.
    feedCodexTerminalChunk(sessionId, 'x'.repeat(8 * 1024))
    vi.advanceTimersByTime(5_000)
    const settled = feedCodexTerminalChunk(
      sessionId,
      '› Improve documentation in @filename\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(settled.promptReady).toBe(true)
  })

  it('still suppresses promptReady when the working banner has scrolled out of the buffer but was seen recently', () => {
    // The user-reported regression: codex emits "Calculating discount summaries
    // (1m 55s · esc to interrupt)" between bursts of large file-diff output. A
    // single tick easily exceeds the 4KB rolling buffer, so the banner is no
    // longer in `state.buffer` even though codex is still actively working.
    // The previous buffer-only check let prompt-ready fire here, which yanked
    // normalized state back to idle and toggled the "needs input" badge while
    // the agent was mid-turn.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const sessionId = 'sess-banner-flushed'

    // Codex shows the working banner.
    feedCodexTerminalChunk(
      sessionId,
      'Calculating discount summaries (1m 55s · esc to interrupt)\n',
    )
    // Codex emits a big chunk of diff/code content that flushes the banner
    // out of the rolling buffer entirely.
    feedCodexTerminalChunk(sessionId, 'x'.repeat(8 * 1024))
    // A very short time later (well within a single spinner tick) codex
    // repaints the prompt area.
    vi.advanceTimersByTime(50)
    const repaint = feedCodexTerminalChunk(
      sessionId,
      '› Run /review on my current changes\n  gpt-5.5 high fast · ~/Tedy/orchestra',
    )
    expect(repaint.promptReady).toBe(false)
  })
})
