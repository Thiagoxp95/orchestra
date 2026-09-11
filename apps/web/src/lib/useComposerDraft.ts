'use client'

import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import {
  clearSubmittedDraft as clearDraftRevision,
  getDraftRevision as readDraftRevision,
  loadComposer,
  subscribeComposer,
  updateComposer,
  type Attachment,
  type ParkedComposer,
} from './composer-draft'

const SERVER_SNAPSHOT: ParkedComposer = { draft: '', attachments: [] }

export interface ComposerDraftState extends ParkedComposer {
  setDraft: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  getDraftRevision: () => number
  clearSubmittedDraft: (revision: number) => void
}

export function useComposerDraft(sessionId: string): ComposerDraftState {
  const subscribe = useCallback(
    (listener: () => void) => subscribeComposer(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(() => loadComposer(sessionId), [sessionId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT)

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>(
    (action) => {
      updateComposer(sessionId, (current) => {
        const draft = typeof action === 'function' ? action(current.draft) : action
        return draft === current.draft ? current : { ...current, draft }
      })
    },
    [sessionId],
  )

  const setAttachments = useCallback<Dispatch<SetStateAction<Attachment[]>>>(
    (action) => {
      updateComposer(sessionId, (current) => {
        const attachments = typeof action === 'function' ? action(current.attachments) : action
        return attachments === current.attachments ? current : { ...current, attachments }
      })
    },
    [sessionId],
  )

  const getDraftRevision = useCallback(() => readDraftRevision(sessionId), [sessionId])
  const clearSubmittedDraft = useCallback(
    (revision: number) => clearDraftRevision(sessionId, revision),
    [sessionId],
  )

  return { ...snapshot, setDraft, setAttachments, getDraftRevision, clearSubmittedDraft }
}
