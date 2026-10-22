// src/main/dictation/socket.ts
//
// The phone's hold-to-talk button, over WS /api/dictate. The socket opens with
// the terminal view (which warms the ears) and carries, per press:
//
//   → {"t":"start","id":n}                button down
//   → binary                              16 kHz mono PCM16, as it's recorded
//   → {"t":"end","id":n}                  button up
//   ← {"t":"text","id":n,"text":"...","ms":..} | {"t":"error","id":n,"message":"..."}
//   → {"t":"cancel","id":n}               the press was abandoned
//
// The desktop only hears; the phone types the text into the session itself,
// through the same input path as its paste button.

import { WebSocket } from 'ws'
import { clean, stopCleanup, warmCleanup } from './cleanup'
import { hear, startEars, stopEars } from './ears'
import { DictationSession } from './session'

/** The model holds GPU memory: let it go once no phone has had a terminal open for this long. */
const IDLE_MS = 30 * 60_000

/** Ten minutes of 16 kHz PCM16; past this the recording keeps its start. */
const MAX_BYTES = 16_000 * 2 * 600

type ClientMessage =
  | { t: 'start'; id: number }
  | { t: 'end'; id: number }
  | { t: 'cancel'; id: number }

let users = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** A phone that may dictate soon: load the model now, keep it while held. */
function retain(): () => void {
  users += 1
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  startEars().catch((err: Error) => console.warn('[dictation]', err.message))
  warmCleanup()
  let released = false
  return () => {
    if (released) return
    released = true
    users -= 1
    if (users > 0) return
    idleTimer = setTimeout(stopDictation, IDLE_MS)
  }
}

export function stopDictation(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  stopEars()
  stopCleanup()
}

export function attachDictationSocket(ws: WebSocket): void {
  const release = retain()
  let current: { id: number; session: DictationSession; bytes: number } | null = null
  const send = (message: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
      if (!current || current.bytes + data.length > MAX_BYTES) return
      current.bytes += data.length
      current.session.feed(data)
      return
    }
    let message: ClientMessage
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.t === 'start') {
      current = { id: message.id, session: new DictationSession({ hear, clean }), bytes: 0 }
      return
    }
    if (current?.id !== message.id) return
    const { id, session } = current
    current = null
    if (message.t !== 'end') return
    session
      .finish()
      .then((result) => {
        console.log(`[dictation] ${JSON.stringify({ how: result.how, ahead: result.ahead, parts: result.parts, ms: result.ms })}`)
        send({ t: 'text', id, text: result.text, ms: result.ms })
      })
      .catch((err: unknown) => send({ t: 'error', id, message: err instanceof Error ? err.message : String(err) }))
  })

  ws.on('error', () => {})
  ws.on('close', release)
}
