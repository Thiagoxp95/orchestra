import { describe, expect, it } from 'vitest'
import {
  clearSubmittedDraft,
  draftKey,
  getDraftRevision,
  loadComposer,
  parkComposer,
  patchParkedAttachment,
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
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++
      map.set(key, value)
    },
    removeItem: (key: string) => {
      writes++
      map.delete(key)
    },
  }
}

function attachment(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, previewUrl: `blob:${id}`, mime: 'image/png', status: 'ready', filePath: `/tmp/${id}`, ...over }
}

describe('observable composer draft', () => {
  it('returns one stable snapshot for sessions with no composer', () => {
    const store = fakeStore()
    expect(loadComposer('desktop-empty-a', store)).toBe(loadComposer('desktop-empty-b', store))
  })

  it('notifies only the changed session and cleans up subscriptions', () => {
    const store = fakeStore()
    let firstCalls = 0
    let otherCalls = 0
    const unsubscribe = subscribeComposer('desktop-observed', () => firstCalls++)
    const unsubscribeOther = subscribeComposer('desktop-other', () => otherCalls++)

    parkComposer('desktop-other-source', { draft: 'elsewhere', attachments: [] }, store)
    parkComposer('desktop-observed', { draft: 'one', attachments: [] }, store)
    unsubscribe()
    unsubscribeOther()
    parkComposer('desktop-observed', { draft: 'two', attachments: [] }, store)

    expect(firstCalls).toBe(1)
    expect(otherCalls).toBe(0)
  })

  it('publishes an upload completion to a remounted subscriber', () => {
    const store = fakeStore()
    parkComposer('desktop-upload', {
      draft: '',
      attachments: [attachment('image', { status: 'uploading', filePath: undefined })],
    }, store)
    const seen: ParkedComposer[] = []
    const unsubscribe = subscribeComposer('desktop-upload', () => {
      seen.push(loadComposer('desktop-upload', store))
    })

    patchParkedAttachment('desktop-upload', 'image', { status: 'ready', filePath: '/tmp/ready' })
    unsubscribe()

    expect(seen.at(-1)?.attachments[0]).toMatchObject({ status: 'ready', filePath: '/tmp/ready' })
  })

  it('lets a late completion clear only the version it submitted', () => {
    const store = fakeStore()
    const submittedAttachments = [attachment('sent')]
    parkComposer('desktop-send', { draft: 'submitted', attachments: submittedAttachments }, store)
    parkComposer('desktop-send', { draft: 'newer edit', attachments: [attachment('new')] }, store)

    updateComposer(
      'desktop-send',
      (current) => ({
        draft: current.draft === 'submitted' ? '' : current.draft,
        attachments: current.attachments === submittedAttachments ? [] : current.attachments,
      }),
      store,
    )

    expect(loadComposer('desktop-send', store)).toEqual({
      draft: 'newer edit',
      attachments: [attachment('new')],
    })
  })

  it('does not notify or rewrite storage for an equivalent update', () => {
    const store = fakeStore()
    parkComposer('desktop-stable', { draft: 'same', attachments: [attachment('same')] }, store)
    let notifications = 0
    const unsubscribe = subscribeComposer('desktop-stable', () => notifications++)

    updateComposer(
      'desktop-stable',
      () => ({ draft: 'same', attachments: [attachment('same')] }),
      store,
    )
    unsubscribe()

    expect(notifications).toBe(0)
    expect(store.writes).toBe(1)
  })

  it('keeps an accepted clear authoritative when persistent removal fails', () => {
    const store = fakeStore()
    parkComposer('desktop-failed-clear', { draft: 'stale on disk', attachments: [] }, store)
    const rejectsRemoval = {
      ...store,
      removeItem: () => {
        throw new Error('denied')
      },
    }

    parkComposer('desktop-failed-clear', { draft: '', attachments: [] }, rejectsRemoval)

    expect(loadComposer('desktop-failed-clear', rejectsRemoval)).toEqual({ draft: '', attachments: [] })
  })

  it('does not clear text that was erased and then retyped while a send was pending', () => {
    const store = fakeStore()
    parkComposer('desktop-aba', { draft: 'continue', attachments: [] }, store)
    const submittedRevision = getDraftRevision('desktop-aba', store)
    parkComposer('desktop-aba', { draft: 'other', attachments: [] }, store)
    parkComposer('desktop-aba', { draft: '', attachments: [] }, store)
    parkComposer('desktop-aba', { draft: 'continue', attachments: [] }, store)

    clearSubmittedDraft('desktop-aba', submittedRevision, store)

    expect(loadComposer('desktop-aba', store).draft).toBe('continue')
    expect(getDraftRevision('desktop-aba', store)).not.toBe(submittedRevision)
  })

  it('clears the submitted draft generation while preserving newer attachments', () => {
    const store = fakeStore()
    parkComposer('desktop-revision-clear', { draft: 'continue', attachments: [attachment('sent')] }, store)
    const submittedRevision = getDraftRevision('desktop-revision-clear', store)
    parkComposer('desktop-revision-clear', { draft: 'continue', attachments: [attachment('new')] }, store)

    clearSubmittedDraft('desktop-revision-clear', submittedRevision, store)

    expect(loadComposer('desktop-revision-clear', store)).toEqual({
      draft: '',
      attachments: [attachment('new')],
    })
  })

  it('assigns a stable nonzero revision when hydrating a persisted draft', () => {
    const store = fakeStore()
    store.map.set(draftKey('desktop-hydrated-revision'), 'restored')

    const revision = getDraftRevision('desktop-hydrated-revision', store)

    expect(revision).toBeGreaterThan(0)
    expect(getDraftRevision('desktop-hydrated-revision', store)).toBe(revision)
    expect(loadComposer('desktop-hydrated-revision', store).draft).toBe('restored')
  })
})
