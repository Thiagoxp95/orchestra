/**
 * The chat composer's contents have to outlive the pane that holds them.
 * TerminalPane — and the ChatPane overlay inside it — is re-keyed on every
 * foreground so the terminal can re-anchor its chunk stream (useForegroundNonce),
 * which means an ordinary app switch on the phone unmounts the composer. Without
 * somewhere to park them, a typed message and its attached screenshots were gone
 * by the time you came back.
 *
 * Two layers, because the two ways out of a composer lose different things:
 *   - the module-level park carries everything across a REMOUNT inside the same
 *     document (the app switch). Attachment previews are object URLs — valid
 *     only for that document's life — so this is the only place they can ride;
 *   - localStorage carries the text across the DOCUMENT itself, which iOS
 *     discards when it reclaims a backgrounded tab. Object URLs are dead by
 *     then, so a reload restores what you typed and not the thumbnails.
 */

/**
 * One picked image riding the composer until send. previewUrl is an object URL.
 *
 * On the desktop "uploading" means writing the bytes into the same on-disk
 * staging directory a phone-sent screenshot lands in (chat-save-image), and the
 * resolved handle is that FILE PATH rather than the phone's Convex storageId —
 * the TUI is handed paths either way, so this is where the round trip is cut.
 * It still resolves asynchronously and can still fail, so the chip's three
 * states carry over unchanged.
 */
export type Attachment = {
  id: string
  previewUrl: string
  mime: string
  status: 'uploading' | 'ready' | 'error'
  filePath?: string
}

/** How a staged image resolves — applied to the chip whichever mount is listening. */
export type AttachmentPatch = { status: 'ready'; filePath: string } | { status: 'error' }

export type ParkedComposer = { draft: string; attachments: Attachment[] }

type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const parked = new Map<string, ParkedComposer>()
const uploads = new Map<string, Promise<AttachmentPatch>>()

function defaultStore(): DraftStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function draftKey(sessionId: string): string {
  return `orchestra.chatDraft.${sessionId}`
}

/**
 * Record the composer's current contents where the next mount will find them.
 * Called on every change rather than from an unmount cleanup: a discarded page
 * never runs a cleanup, and the localStorage half exists precisely for that case.
 */
export function parkComposer(
  sessionId: string,
  composer: ParkedComposer,
  store: DraftStore | null = defaultStore(),
): void {
  if (composer.draft || composer.attachments.length > 0) parked.set(sessionId, composer)
  else parked.delete(sessionId)
  try {
    if (composer.draft) store?.setItem(draftKey(sessionId), composer.draft)
    else store?.removeItem(draftKey(sessionId))
  } catch {
    // Quota or private mode. The in-document park still covers the app switch,
    // which is the case that happens every day.
  }
}

/** What a fresh mount starts from: the parked copy, else whatever a discarded
 *  document left behind (text only — its object URLs died with it). */
export function loadComposer(
  sessionId: string,
  store: DraftStore | null = defaultStore(),
): ParkedComposer {
  const held = parked.get(sessionId)
  if (held) return held
  let draft = ''
  try {
    draft = store?.getItem(draftKey(sessionId)) ?? ''
  } catch {
    draft = ''
  }
  return { draft, attachments: [] }
}

/**
 * Apply an upload's result to the parked copy. The mount that started the
 * upload may be gone by the time it lands (backgrounding mid-upload does that),
 * and its setState then goes nowhere — so the park is patched directly, or the
 * chip comes back a spinner that never resolves and blocks send.
 */
export function patchParkedAttachment(
  sessionId: string,
  id: string,
  patch: AttachmentPatch,
): void {
  const held = parked.get(sessionId)
  if (!held) return
  parked.set(sessionId, {
    ...held,
    attachments: held.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  })
}

/** Park an in-flight upload so the next mount can re-attach to its result. */
export function rememberUpload(id: string, upload: Promise<AttachmentPatch>): void {
  uploads.set(id, upload)
}

/** The in-flight (or already settled) upload for a chip restored from the park. */
export function pendingUpload(id: string): Promise<AttachmentPatch> | undefined {
  return uploads.get(id)
}

/** Drop an upload's record once its chip has left the composer (sent or removed).
 *  Kept until then — deleting on resolve would strand a remount that hydrated
 *  the chip in the window between the promise settling and the new mount's
 *  effects running. */
export function forgetUpload(id: string): void {
  uploads.delete(id)
}
