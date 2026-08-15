import { describe, expect, it } from 'vitest'
import { detectTuiPrompt } from './tui-prompt-detector'

// The real folder-trust gate (claude 2.1.233), as getTerminalBufferText would
// hand it over: ANSI stripped, runs of spaces collapsed.
const TRUST_SCREEN =
  'Accessing workspace: /private/var/folders/T/probe-x ' +
  'Quick safety check: Is this a project you created or one you trust? ' +
  "(Like your own code…) Claude Code'll be able to read, edit, and execute files here. " +
  'Security guide ❯ 1. Yes, I trust this folder 2. No, exit Enter to confirm · Esc to cancel'

describe('detectTuiPrompt', () => {
  it('cards the folder-trust gate with guarded digit+enter answers', () => {
    const prompt = detectTuiPrompt(TRUST_SCREEN)
    expect(prompt?.kind).toBe('trust')
    expect(prompt?.options.map((o) => o.label)).toEqual(['Yes, I trust this folder', 'No, exit'])
    // Yes = type "1" then Enter, both guarded so a stale card is a no-op.
    expect(prompt?.options[0].keys.map((k) => k.data)).toEqual(['1', '\r'])
    expect(prompt?.options[0].keys.every((k) => k.ifScreenContains === 'trust this folder')).toBe(true)
    expect(prompt?.options[1].keys.map((k) => k.data)).toEqual(['2', '\r'])
  })

  it('only fires when the prompt is at the TAIL — a scrolled-away copy is ignored', () => {
    // The prompt text sits far from the end (answered, reply flooded past it).
    const stale = TRUST_SCREEN + ' '.repeat(0) + 'x'.repeat(2000)
    expect(detectTuiPrompt(stale)).toBeNull()
  })

  it('does not card on prose that merely mentions trusting a folder', () => {
    expect(
      detectTuiPrompt('I should probably trust this folder but let me check the files first, ok?'),
    ).toBeNull()
  })

  it('cards a proceed/permission prompt', () => {
    const screen =
      'Bash(rm -rf build) Do you want to proceed? ❯ 1. Yes 2. No Esc to cancel'
    const prompt = detectTuiPrompt(screen)
    expect(prompt?.kind).toBe('proceed')
    expect(prompt?.options[0].keys.map((k) => k.data)).toEqual(['1', '\r'])
    // No = Esc.
    expect(prompt?.options.at(-1)?.keys.map((k) => k.data)).toEqual(['\x1b'])
  })

  it('returns null for an ordinary screen', () => {
    expect(detectTuiPrompt('❯ npm test\n all good')).toBeNull()
    expect(detectTuiPrompt('')).toBeNull()
  })
})
