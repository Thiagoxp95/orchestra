import { useEffect, useRef } from 'react'
import { buildVoiceVocabularyForWorkspace, useAppStore } from '../store/app-store'
import type { VoiceEvent } from '../../../shared/types'

/**
 * Top-level voice integration hook. Mounted once at the App layer.
 *
 *   - Listens for matched IPC events and dispatches the matched action via
 *     the existing runAction store path so background commands, claude/codex
 *     routing, and run-history all work without per-feature plumbing.
 *   - Subscribes to workspace + customAction changes and pushes the
 *     resulting vocabulary to the sidecar whenever it changes.
 *   - Auto-enables the sidecar on app start when settings.voice.enabled is
 *     true, and toggles enable/disable when that setting changes.
 *
 * No UI — VoiceIndicator subscribes directly to onVoiceEvent for visuals.
 */
export function useVoice(): void {
  const voiceEnabled = useAppStore((s) => s.settings.voice?.enabled ?? false)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)

  const lastVocabKey = useRef<string>('')

  // Dispatch matched events into runAction.
  useEffect(() => {
    const unsub = window.electronAPI.onVoiceEvent((event: VoiceEvent) => {
      if (event.type !== 'matched') return
      const state = useAppStore.getState()
      const wsId = state.activeWorkspaceId
      if (!wsId) return
      const ws = state.workspaces[wsId]
      if (!ws) return
      const action = ws.customActions.find((a) => a.id === event.actionId)
      if (!action) {
        // Stale id — caller already drops, but guard anyway.
        return
      }
      try {
        state.runAction(wsId, action)
      } catch (err) {
        console.error('[voice] runAction failed', err)
      }
    })
    return () => { unsub() }
  }, [])

  // Push vocabulary whenever the active workspace's actionable phrases change.
  useEffect(() => {
    const ws = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
    const vocab = buildVoiceVocabularyForWorkspace(ws)
    const key = JSON.stringify(vocab)
    if (key === lastVocabKey.current) return
    lastVocabKey.current = key
    window.electronAPI.voiceSetVocabulary(vocab)
  }, [activeWorkspaceId, workspaces])

  // Auto-enable / disable the sidecar based on the persisted toggle.
  useEffect(() => {
    if (voiceEnabled) {
      window.electronAPI.voiceEnable().catch((err: unknown) => {
        console.error('[voice] enable failed', err)
      })
    } else {
      window.electronAPI.voiceDisable().catch(() => {})
    }
  }, [voiceEnabled])
}
