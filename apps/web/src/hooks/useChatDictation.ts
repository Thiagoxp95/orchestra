'use client'
import { useCallback, useMemo, useRef } from 'react'
import { useDictation } from './useDictation'
import type { ChatDictation } from '../chat'

/**
 * Web-side adapter between the mic pipeline (`useDictation`) and the chat
 * module, which can't import it: chat/ is compiled into the desktop renderer
 * too, where `lib/sync` doesn't exist. The pane owns the draft and registers a
 * sink; this hook owns the mic and feeds it.
 *
 * `target: 'chat'` keeps the transcript off the session's PTY — in chat view
 * that PTY is an idle shell, and the desktop typing the text there would leave
 * a stray command sitting at the prompt.
 */
export function useChatDictation(sessionId: string): ChatDictation {
  const sinkRef = useRef<((text: string) => void) | null>(null)
  const onFinalText = useCallback((text: string) => sinkRef.current?.(text), [])
  // No input-lease getter: a chat utterance never writes to the terminal, so it
  // must not be cancelled when another client takes terminal control.
  const { isDictating, isProcessing, error, start, stop, getLevel } = useDictation(
    sessionId,
    onFinalText,
    undefined,
    'chat',
  )
  const bindTranscript = useCallback((sink: ((text: string) => void) | null) => {
    sinkRef.current = sink
  }, [])

  return useMemo(
    () => ({
      recording: isDictating,
      processing: isProcessing,
      error,
      start,
      stop,
      getLevel,
      bindTranscript,
    }),
    [isDictating, isProcessing, error, start, stop, getLevel, bindTranscript],
  )
}
