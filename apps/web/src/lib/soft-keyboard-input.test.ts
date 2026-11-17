import { expect, test } from 'vitest'
import { bindSoftKeyboardInput, lineEditBytes } from './soft-keyboard-input'

const apply = (line: string, bytes: string) => {
  let out = [...line]
  for (const ch of bytes) out = ch === '\x7f' ? out.slice(0, -1) : [...out, ch]
  return out.join('')
}

test.each([
  ['typing appends', 'lets start', 'lets start a', ' a'],
  ['autocorrect rewrites only the word it changed', 'i just ryped', 'i just typed', '\x7f\x7f\x7f\x7f\x7ftyped'],
  ['a picked suggestion extends the word, never the line', 'custom android lauc', 'custom android launcher ', '\x7fncher '],
  ['backspace', 'abc', 'ab', '\x7f'],
  ['an emoji is one DEL, not half a surrogate pair', 'hi 😀', 'hi 😃', '\x7f😃'],
  ['no change sends nothing', 'same', 'same', ''],
])('%s', (_, before, after, bytes) => {
  expect(lineEditBytes(before, after)).toBe(bytes)
  expect(apply(before, bytes)).toBe(after)
})

test('a paste is sent once: xterm sends it, and the textarea echo that follows is not sent again', async () => {
  const parent = new EventTarget()
  const textarea = { value: '', selectionStart: 0, parentElement: parent } as unknown as HTMLTextAreaElement
  const fire = (type: string) => {
    const e = new Event(type)
    Object.defineProperty(e, 'target', { value: textarea })
    parent.dispatchEvent(e)
  }
  const sent: string[] = []
  bindSoftKeyboardInput(textarea, data => sent.push(data))
  const type = (value: string) => { fire('beforeinput'); textarea.value = value; fire('input') }

  type('ok ')
  fire('paste')  // xterm sends the clipboard itself and empties the textarea; the browser then inserts it
  textarea.value = ''
  type('Sim, é verdade.')
  await new Promise(r => setTimeout(r))
  type('Sim, é verdade. a')
  expect(sent).toEqual(['ok ', ' a'])
})
