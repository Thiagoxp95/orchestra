import { describe, expect, it } from 'vitest'
import type { NativeChatSnapshot } from './native-chat'
import {
  buildNativeAnswers,
  classifyNativeDraft,
  nativeChatPickerCatalog,
  newerNativeSnapshot,
  parseNativeModelCommand,
  shouldUseNativeInterrupt,
} from './native-chat-ui'

function snapshot(sessionId: string, revision: number): NativeChatSnapshot {
  return {
    sessionId,
    provider: 'claude',
    cwd: '/tmp/project',
    settings: {},
    status: 'idle',
    requests: [],
    revision,
  }
}

describe('classifyNativeDraft', () => {
  it('turns the compact slash command into an out-of-band command', () => {
    expect(classifyNativeDraft('  /compact  ', [], false)).toEqual({
      command: { kind: 'compact' },
    })
  })

  it('does not discard attachments when compact is submitted', () => {
    expect(classifyNativeDraft('/compact', ['image.png'], false)).toEqual({
      error: 'Remove attachments before compacting the conversation.',
    })
  })

  it('rejects clear instead of forwarding it as a provider prompt', () => {
    expect(classifyNativeDraft('/clear', [], false)).toEqual({
      error: 'Native chat cannot clear this conversation. Start a new session instead.',
    })
  })

  it('keeps unknown slash commands as provider text', () => {
    expect(classifyNativeDraft('/review changes', ['image.png'], true)).toEqual({
      command: { kind: 'send', text: '/review changes', images: ['image.png'], steer: true },
    })
  })
})

describe('newerNativeSnapshot', () => {
  it('does not let a stale request response replace a newer pushed revision', () => {
    expect(newerNativeSnapshot(snapshot('one', 4), snapshot('one', 3), 'one')).toEqual(
      snapshot('one', 4),
    )
  })

  it('ignores snapshots emitted for a different session', () => {
    expect(newerNativeSnapshot(snapshot('one', 2), snapshot('two', 9), 'one')).toEqual(
      snapshot('one', 2),
    )
  })

  it('does not let a delayed legacy lookup erase a pushed native snapshot', () => {
    expect(newerNativeSnapshot(snapshot('one', 2), null, 'one')).toEqual(snapshot('one', 2))
  })
})

describe('buildNativeAnswers', () => {
  it('combines selected options and a trimmed free-text answer by question id', () => {
    expect(
      buildNativeAnswers({
        framework: { selected: ['React', 'Vue'], freeText: '  Svelte  ' },
        empty: { selected: [], freeText: '   ' },
      }),
    ).toEqual({ framework: ['React', 'Vue', 'Svelte'], empty: [] })
  })
})

describe('shouldUseNativeInterrupt', () => {
  it('routes Stop to native chat while enrollment is still discovering the session', () => {
    expect(shouldUseNativeInterrupt(false, true)).toBe(true)
    expect(shouldUseNativeInterrupt(false, false)).toBe(false)
    expect(shouldUseNativeInterrupt(true, false)).toBe(true)
  })
})

describe('nativeChatPickerCatalog', () => {
  const legacyCodex = {
    models: [
      { value: '1', label: 'gpt-5.6-sol', hint: 'Frontier coding' },
      { value: '2', label: 'gpt-5.6-terra' },
    ],
    efforts: [
      { value: '1', label: 'Low' },
      { value: '4', label: 'Extra high' },
      { value: '5,1', label: 'Max' },
    ],
  }

  it('uses provider model ids and the selected model effort catalog', () => {
    expect(
      nativeChatPickerCatalog(
        'codex',
        [
          { id: 'gpt-real-a', label: 'Real A', efforts: ['low', 'high'] },
          { id: 'gpt-real-b', label: 'Real B', efforts: ['medium', 'xhigh'] },
        ],
        'gpt-real-b',
        legacyCodex,
      ),
    ).toEqual({
      models: [
        { value: 'gpt-real-a', label: 'Real A' },
        { value: 'gpt-real-b', label: 'Real B' },
      ],
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'xhigh', label: 'Extra high' },
      ],
    })
  })

  it('converts legacy Codex rows to protocol values when no provider catalog is available', () => {
    expect(nativeChatPickerCatalog('codex', undefined, undefined, legacyCodex)).toEqual({
      models: [
        { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol', hint: 'Frontier coding' },
        { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
      ],
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'xhigh', label: 'Extra high' },
        { value: 'max', label: 'Max' },
      ],
    })
  })
})

describe('parseNativeModelCommand', () => {
  const catalog = {
    models: [{ value: 'gpt-real', label: 'Real model' }],
    efforts: [{ value: 'xhigh', label: 'Extra high' }],
  }

  it('returns direct provider values instead of legacy picker digits', () => {
    expect(parseNativeModelCommand('/model gpt-real', catalog)).toEqual({ model: 'gpt-real' })
    expect(parseNativeModelCommand('/effort Extra high', catalog)).toEqual({ effort: 'xhigh' })
  })

  it('never routes legacy numeric picker values into native configure', () => {
    expect(parseNativeModelCommand('/model 1', catalog)).toEqual({
      error: 'Use a model name instead of a legacy picker number.',
    })
    expect(parseNativeModelCommand('/effort 5,1', catalog)).toEqual({
      error: 'Use an effort name instead of a legacy picker number.',
    })
  })

  it('explains when a native model command is missing its protocol argument', () => {
    expect(parseNativeModelCommand('/model', catalog)).toEqual({
      error: 'Type /model followed by a model name.',
    })
  })
})
