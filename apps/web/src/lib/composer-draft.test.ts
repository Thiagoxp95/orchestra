import { describe, it, expect } from 'vitest'
import {
  draftKey,
  forgetUpload,
  loadComposer,
  parkComposer,
  patchParkedAttachment,
  pendingUpload,
  rememberUpload,
  type Attachment,
} from './composer-draft'

function fakeStore() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
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
