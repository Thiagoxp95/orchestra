import { expect, test } from 'vitest'
import { lineEditBytes } from './soft-keyboard-input'

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
