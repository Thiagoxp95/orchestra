import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../desktop/src/shared/chat-message'
import { makeNativeEcho, pruneNativeEchoes, upsertMessages } from './native-messages'
import { nativeChatModels } from '../../../desktop/src/shared/native-chat-catalog'

const text = (uid: string, body: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({
  uid,
  role,
  blocks: [{ kind: 'text', text: body }],
})

describe('upsertMessages', () => {
  it('replaces a streaming row in place and appends new ones', () => {
    const prev = [text('a', 'hi', 'user'), text('b', 'Hel')]
    const next = upsertMessages(prev, [text('b', 'Hello'), text('c', 'more')])
    expect(next.map((m) => m.uid)).toEqual(['a', 'b', 'c'])
    expect(next[1].blocks).toEqual([{ kind: 'text', text: 'Hello' }])
    expect(prev[1].blocks).toEqual([{ kind: 'text', text: 'Hel' }])
  })

  it('returns the same array when the push changes nothing', () => {
    const prev = [text('a', 'hi')]
    expect(upsertMessages(prev, [text('a', 'hi')])).toBe(prev)
    expect(upsertMessages(prev, [])).toBe(prev)
  })

  it('keeps only the newest rows past the cap', () => {
    const next = upsertMessages([text('a', '1'), text('b', '2')], [text('c', '3')], 2)
    expect(next.map((m) => m.uid)).toEqual(['b', 'c'])
  })
})

describe('native echoes', () => {
  it('stays until a user row beyond its baseline arrives', () => {
    const history = [text('u1', 'first', 'user'), text('a1', 'reply')]
    const echo = makeNativeEcho('second', 1, 1, 'n', 5)
    expect(echo.message).toEqual({
      uid: 'local:n',
      role: 'user',
      blocks: [{ kind: 'image' }, { kind: 'text', text: 'second' }],
      ts: 5,
    })
    const echoes = [echo]
    expect(pruneNativeEchoes(echoes, history)).toBe(echoes)
    expect(pruneNativeEchoes(echoes, [...history, text('u2', 'second', 'user')])).toEqual([])
  })
})

describe('nativeChatModels', () => {
  it('falls back to the static catalog and keeps the running model visible', () => {
    const models = nativeChatModels('cursor', undefined, 'mystery-model')
    expect(models[0]).toEqual({ id: 'mystery-model', label: 'mystery-model', efforts: [] })
    expect(models.some((m) => m.id === 'composer-2')).toBe(true)
  })

  it('prefers the live catalog, borrowing static labels for bare ids', () => {
    const models = nativeChatModels('claude', [
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['high'] },
      { id: 'new-model', label: 'New Model', efforts: [] },
    ], 'claude-opus-5-5')
    expect(models).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['high'] },
      { id: 'new-model', label: 'New Model', efforts: [] },
    ])
  })
})
