import { describe, it, expect } from 'vitest'
import {
  clearSubmittedDraft,
  draftKey,
  forgetUpload,
  getDraftRevision,
  loadComposer,
  parkComposer,
  patchParkedAttachment,
  pendingUpload,
  rememberUpload,
  subscribeComposer,
  updateComposer,
  type Attachment,
  type ParkedComposer,
} from './composer-draft'

function fakeStore() {
  const map = new Map<string, string>()
  let writes = 0
  return {
    map,
    get writes() {
      return writes
    },
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes++
      map.set(k, v)
    },
    removeItem: (k: string) => {
      writes++
      map.delete(k)
    },
  }
}

function attachment(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, previewUrl: `blob:${id}`, mime: 'image/png', status: 'ready', storageId: 's1', ...over }
}

describe('parkComposer / loadComposer', () => {
  it('hands a remount the text and the attachments it left behind', () => {
    const store = fakeStore()
    parkComposer('a1', { draft: 'half a thought', attachments: [attachment('i1')] }, store)
    const restored = loadComposer('a1', store)
    expect(restored.draft).toBe('half a thought')
    expect(restored.attachments).toEqual([attachment('i1')])
  })

  it('restores only the text once the document is gone (object URLs die with it)', () => {
    const store = fakeStore()
    parkComposer('a2', { draft: 'typed then backgrounded', attachments: [attachment('i2')] }, store)
    // A discarded page keeps localStorage but not the module-level park.
    expect(store.getItem(draftKey('a2'))).toBe('typed then backgrounded')
    const afterReload = loadComposer('a3-unparked', {
      ...store,
      getItem: (k: string) => (k === draftKey('a3-unparked') ? 'typed then backgrounded' : null),
    })
    expect(afterReload.draft).toBe('typed then backgrounded')
    expect(afterReload.attachments).toEqual([])
  })

  it('forgets a composer that has been emptied (sent)', () => {
    const store = fakeStore()
    parkComposer('a4', { draft: 'about to send', attachments: [] }, store)
    parkComposer('a4', { draft: '', attachments: [] }, store)
    expect(loadComposer('a4', store)).toEqual({ draft: '', attachments: [] })
    expect(store.getItem(draftKey('a4'))).toBeNull()
  })

  it('keeps sessions apart', () => {
    const store = fakeStore()
    parkComposer('s1', { draft: 'one', attachments: [] }, store)
    parkComposer('s2', { draft: 'two', attachments: [] }, store)
    expect(loadComposer('s1', store).draft).toBe('one')
    expect(loadComposer('s2', store).draft).toBe('two')
  })

  it('survives a storage that throws (private mode, quota)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(() => parkComposer('a5', { draft: 'x', attachments: [] }, throwing)).not.toThrow()
    // The in-document park is unaffected by the failing store.
    expect(loadComposer('a5', throwing).draft).toBe('x')
  })
})

describe('patchParkedAttachment', () => {
  it('lands an upload that finished after the pane was remounted', () => {
    const store = fakeStore()
    parkComposer(
      'a6',
      { draft: '', attachments: [attachment('i6', { status: 'uploading', storageId: undefined })] },
      store,
    )
    patchParkedAttachment('a6', 'i6', { status: 'ready', storageId: 'sid-6' })
    expect(loadComposer('a6', store).attachments[0]).toMatchObject({
      status: 'ready',
      storageId: 'sid-6',
    })
  })

  it('is a no-op for a composer nobody parked', () => {
    expect(() => patchParkedAttachment('never-parked', 'i7', { status: 'error' })).not.toThrow()
  })
})

describe('upload registry', () => {
  it('lets the next mount re-attach to an upload in flight', async () => {
    const upload = Promise.resolve<{ status: 'ready'; storageId: string }>({
      status: 'ready',
      storageId: 'sid-8',
    })
    rememberUpload('i8', upload)
    await expect(pendingUpload('i8')).resolves.toEqual({ status: 'ready', storageId: 'sid-8' })
  })

  it('drops the record once the chip leaves the composer', () => {
    rememberUpload('i9', Promise.resolve({ status: 'error' }))
    forgetUpload('i9')
    expect(pendingUpload('i9')).toBeUndefined()
  })
})

describe('observable composer draft', () => {
  it('returns one stable snapshot for sessions with no composer', () => {
    const store = fakeStore()
    expect(loadComposer('web-empty-a', store)).toBe(loadComposer('web-empty-b', store))
  })

  it('notifies only the changed session and cleans up subscriptions', () => {
    const store = fakeStore()
    let firstCalls = 0
    let otherCalls = 0
    const unsubscribe = subscribeComposer('web-observed', () => firstCalls++)
    const unsubscribeOther = subscribeComposer('web-other', () => otherCalls++)

    parkComposer('web-other-source', { draft: 'elsewhere', attachments: [] }, store)
    parkComposer('web-observed', { draft: 'one', attachments: [] }, store)
    unsubscribe()
    unsubscribeOther()
    parkComposer('web-observed', { draft: 'two', attachments: [] }, store)

    expect(firstCalls).toBe(1)
    expect(otherCalls).toBe(0)
  })

  it('publishes an upload completion to a remounted subscriber', () => {
    const store = fakeStore()
    parkComposer('web-upload', {
      draft: '',
      attachments: [attachment('image', { status: 'uploading', storageId: undefined })],
    }, store)
    const seen: ParkedComposer[] = []
    const unsubscribe = subscribeComposer('web-upload', () => {
      seen.push(loadComposer('web-upload', store))
    })

    patchParkedAttachment('web-upload', 'image', { status: 'ready', storageId: 'ready' })
    unsubscribe()

    expect(seen.at(-1)?.attachments[0]).toMatchObject({ status: 'ready', storageId: 'ready' })
  })

  it('lets a late completion clear only the version it submitted', () => {
    const store = fakeStore()
    const submittedAttachments = [attachment('sent')]
    parkComposer('web-send', { draft: 'submitted', attachments: submittedAttachments }, store)
    parkComposer('web-send', { draft: 'newer edit', attachments: [attachment('new')] }, store)

    updateComposer(
      'web-send',
      (current) => ({
        draft: current.draft === 'submitted' ? '' : current.draft,
        attachments: current.attachments === submittedAttachments ? [] : current.attachments,
      }),
      store,
    )

    expect(loadComposer('web-send', store)).toEqual({
      draft: 'newer edit',
      attachments: [attachment('new')],
    })
  })

  it('does not notify or rewrite storage for an equivalent update', () => {
    const store = fakeStore()
    parkComposer('web-stable', { draft: 'same', attachments: [attachment('same')] }, store)
    let notifications = 0
    const unsubscribe = subscribeComposer('web-stable', () => notifications++)

    updateComposer(
      'web-stable',
      () => ({ draft: 'same', attachments: [attachment('same')] }),
      store,
    )
    unsubscribe()

    expect(notifications).toBe(0)
    expect(store.writes).toBe(1)
  })

  it('keeps an accepted clear authoritative when persistent removal fails', () => {
    const store = fakeStore()
    parkComposer('web-failed-clear', { draft: 'stale on disk', attachments: [] }, store)
    const rejectsRemoval = {
      ...store,
      removeItem: () => {
        throw new Error('denied')
      },
    }

    parkComposer('web-failed-clear', { draft: '', attachments: [] }, rejectsRemoval)

    expect(loadComposer('web-failed-clear', rejectsRemoval)).toEqual({ draft: '', attachments: [] })
  })

  it('does not clear text that was erased and then retyped while a send was pending', () => {
    const store = fakeStore()
    parkComposer('web-aba', { draft: 'continue', attachments: [] }, store)
    const submittedRevision = getDraftRevision('web-aba', store)
    parkComposer('web-aba', { draft: 'other', attachments: [] }, store)
    parkComposer('web-aba', { draft: '', attachments: [] }, store)
    parkComposer('web-aba', { draft: 'continue', attachments: [] }, store)

    clearSubmittedDraft('web-aba', submittedRevision, store)

    expect(loadComposer('web-aba', store).draft).toBe('continue')
    expect(getDraftRevision('web-aba', store)).not.toBe(submittedRevision)
  })

  it('clears the submitted draft generation while preserving newer attachments', () => {
    const store = fakeStore()
    parkComposer('web-revision-clear', { draft: 'continue', attachments: [attachment('sent')] }, store)
    const submittedRevision = getDraftRevision('web-revision-clear', store)
    parkComposer('web-revision-clear', { draft: 'continue', attachments: [attachment('new')] }, store)

    clearSubmittedDraft('web-revision-clear', submittedRevision, store)

    expect(loadComposer('web-revision-clear', store)).toEqual({
      draft: '',
      attachments: [attachment('new')],
    })
  })

  it('assigns a stable nonzero revision when hydrating a persisted draft', () => {
    const store = fakeStore()
    store.map.set(draftKey('web-hydrated-revision'), 'restored')

    const revision = getDraftRevision('web-hydrated-revision', store)

    expect(revision).toBeGreaterThan(0)
    expect(getDraftRevision('web-hydrated-revision', store)).toBe(revision)
    expect(loadComposer('web-hydrated-revision', store).draft).toBe('restored')
  })
})
