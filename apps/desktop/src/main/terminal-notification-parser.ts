export interface TerminalNotificationEvent {
  sessionId: string
  title: string
  subtitle: string
  body: string
}

interface PendingKittyNotification {
  title: string
  subtitle: string
  body: string
}

const ESC = '\u001B'
const BEL = '\u0007'
const OSC_RE = new RegExp(`${ESC}\\](\\d+);([\\s\\S]*?)(?:${BEL}|${ESC}\\\\)`, 'g')
const MAX_PENDING_BYTES = 8192

const pendingInputBySession = new Map<string, string>()
const pendingKittyBySession = new Map<string, Map<string, PendingKittyNotification>>()

function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\r/g, '').trim()
}

function notificationId(params: Record<string, string>): string {
  return params.i || 'default'
}

function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) {
      params[trimmed] = '1'
    } else {
      params[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
  }
  return params
}

function getKittySession(sessionId: string): Map<string, PendingKittyNotification> {
  let session = pendingKittyBySession.get(sessionId)
  if (!session) {
    session = new Map()
    pendingKittyBySession.set(sessionId, session)
  }
  return session
}

function handleOsc777(sessionId: string, payload: string, onNotification: (event: TerminalNotificationEvent) => void): void {
  const parts = payload.split(';')
  if (parts[0] !== 'notify') return

  const title = cleanText(parts[1]) || 'Terminal'
  const body = cleanText(parts.slice(2).join(';'))
  if (!body && title === 'Terminal') return

  onNotification({
    sessionId,
    title,
    subtitle: '',
    body: body || title,
  })
}

function handleOsc9(sessionId: string, payload: string, onNotification: (event: TerminalNotificationEvent) => void): void {
  const body = cleanText(payload)
  if (!body) return

  onNotification({
    sessionId,
    title: 'Terminal',
    subtitle: '',
    body,
  })
}

function handleOsc99(sessionId: string, payload: string, onNotification: (event: TerminalNotificationEvent) => void): void {
  const separator = payload.indexOf(':')
  const rawParams = separator >= 0 ? payload.slice(0, separator) : payload
  const textPayload = cleanText(separator >= 0 ? payload.slice(separator + 1) : '')
  const params = parseParams(rawParams)
  const id = notificationId(params)
  const field = params.p
  const done = params.d === '1'
  const session = getKittySession(sessionId)
  const pending = session.get(id) ?? { title: '', subtitle: '', body: '' }

  if (field === 'title') {
    pending.title = textPayload
  } else if (field === 'subtitle') {
    pending.subtitle = textPayload
  } else if (field === 'body') {
    pending.body = textPayload
  } else if (textPayload) {
    pending.body = textPayload
  }

  session.set(id, pending)

  if (!done) return

  session.delete(id)
  const title = cleanText(pending.title) || 'Terminal'
  const body = cleanText(pending.body) || cleanText(textPayload) || title
  if (!body && title === 'Terminal') return

  onNotification({
    sessionId,
    title,
    subtitle: cleanText(pending.subtitle),
    body,
  })
}

function handleOsc(
  sessionId: string,
  code: string,
  payload: string,
  onNotification: (event: TerminalNotificationEvent) => void,
): void {
  if (code === '777') {
    handleOsc777(sessionId, payload, onNotification)
  } else if (code === '9') {
    handleOsc9(sessionId, payload, onNotification)
  } else if (code === '99') {
    handleOsc99(sessionId, payload, onNotification)
  }
}

export function feedTerminalNotifications(
  sessionId: string,
  data: string,
  onNotification: (event: TerminalNotificationEvent) => void,
): void {
  const combined = (pendingInputBySession.get(sessionId) ?? '') + data
  let lastConsumed = 0
  OSC_RE.lastIndex = 0

  for (let match = OSC_RE.exec(combined); match; match = OSC_RE.exec(combined)) {
    lastConsumed = OSC_RE.lastIndex
    handleOsc(sessionId, match[1], match[2], onNotification)
  }

  const tail = combined.slice(lastConsumed)
  if (tail.includes(`${ESC}]`)) {
    pendingInputBySession.set(sessionId, tail.slice(-MAX_PENDING_BYTES))
  } else {
    pendingInputBySession.delete(sessionId)
  }
}

export function clearTerminalNotificationParser(sessionId?: string): void {
  if (sessionId) {
    pendingInputBySession.delete(sessionId)
    pendingKittyBySession.delete(sessionId)
    return
  }

  pendingInputBySession.clear()
  pendingKittyBySession.clear()
}
