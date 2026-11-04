const DEL = '\x7f'

/**
 * Bytes that turn a line the PTY already holds (`before`) into `after`: erase
 * back to where the two part ways, then type the rest.
 */
export function lineEditBytes(before: string, after: string): string {
  let same = 0
  const limit = Math.min(before.length, after.length)
  while (same < limit && before[same] === after[same]) same++
  const code = before.charCodeAt(same - 1)
  if (same > 0 && code >= 0xd800 && code <= 0xdbff) same--
  return DEL.repeat([...before.slice(same)].length) + after.slice(same)
}

/**
 * Owns what a soft keyboard does to xterm's helper textarea. xterm assumes the
 * IME only ever appends to it and sends `newValue.replace(oldValue, '')`, but
 * Android keyboards rewrite text in place (autocorrect, suggestion picks), so
 * the replace misses and xterm sends the whole textarea again, typos it had
 * already deleted on the PTY included. Here every edit is sent as a diff
 * against the textarea's value just before the edit.
 *
 * Listens in the capture phase on the textarea's parent, so xterm's own
 * listeners on the textarea never see these events.
 */
export function bindSoftKeyboardInput(textarea: HTMLTextAreaElement, send: (data: string) => void): () => void {
  const parent = textarea.parentElement!
  let before = textarea.value
  const own = (e: Event) => e.target === textarea
  const onComposition = (e: Event) => { if (own(e)) e.stopPropagation() }
  const onKeyDown = (e: KeyboardEvent) => {
    if (!own(e)) return
    // 229 is an IME keystroke; its text arrives as an input event. A Backspace
    // with text to delete is left to the browser for the same reason: if xterm
    // sent it, the textarea would keep the character the PTY just lost.
    const imeKey = e.isComposing || e.keyCode === 229
    const deletesText = e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && textarea.selectionStart > 0
    if (imeKey || deletesText) e.stopPropagation()
  }
  const onBeforeInput = (e: Event) => { if (own(e)) before = textarea.value }
  const onInput = (e: Event) => {
    if (!own(e)) return
    e.stopPropagation()
    const after = textarea.value
    const bytes = lineEditBytes(before, after)
    before = after
    if (bytes) send(bytes)
  }
  const listeners: [string, (e: never) => void][] = [
    ['compositionstart', onComposition], ['compositionupdate', onComposition], ['compositionend', onComposition],
    ['keydown', onKeyDown], ['beforeinput', onBeforeInput], ['input', onInput],
  ]
  for (const [type, fn] of listeners) parent.addEventListener(type, fn as EventListener, true)
  return () => { for (const [type, fn] of listeners) parent.removeEventListener(type, fn as EventListener, true) }
}
