import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './app-store'

function resetStore(): void {
  useAppStore.setState({
    workspaces: {},
    sessions: {},
    activeWorkspaceId: null,
    activeSessionId: null,
    settings: { worktreesDir: '' },
    showDiffPanel: false,
    diffSelectedFile: null,
    sidebarCollapsed: false,
    claudeLastResponse: {},
    claudeWorkState: {},
    codexLastResponse: {},
    codexWorkState: {},
    sessionNeedsUserInput: {},
    deletingWorktrees: new Set<string>(),
  })
}

describe('app-store agent sidebar state', () => {
  beforeEach(() => {
    resetStore()
  })

  it('preserves the last agent response and reply-needed state when a session returns to terminal', () => {
    useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().activeSessionId
    expect(sessionId).toBeTruthy()
    if (!sessionId) return

    useAppStore.getState().setProcessStatus(sessionId, 'codex')
    useAppStore.getState().setCodexLastResponse(sessionId, 'What should I do next?')
    useAppStore.getState().setSessionNeedsUserInput(sessionId, true)

    useAppStore.getState().setProcessStatus(sessionId, 'terminal')

    const state = useAppStore.getState()
    expect(state.sessions[sessionId]?.processStatus).toBe('terminal')
    expect(state.codexLastResponse[sessionId]).toBe('What should I do next?')
    expect(state.sessionNeedsUserInput[sessionId]).toBe(true)
  })

  it('keeps sidebar response state isolated per session', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const firstSessionId = useAppStore.getState().activeSessionId
    expect(firstSessionId).toBeTruthy()
    if (!firstSessionId) return

    const secondSessionId = useAppStore.getState().createSession(
      workspaceId,
      undefined,
      undefined,
      '__terminal__',
      'Explain code snippet',
      'terminal',
    )

    useAppStore.getState().setProcessStatus(firstSessionId, 'codex')
    useAppStore.getState().setProcessStatus(secondSessionId, 'codex')
    useAppStore.getState().setCodexLastResponse(firstSessionId, 'Session A response')
    useAppStore.getState().setCodexLastResponse(secondSessionId, 'Session B response')
    useAppStore.getState().setSessionNeedsUserInput(firstSessionId, true)
    useAppStore.getState().setSessionNeedsUserInput(secondSessionId, true)

    useAppStore.getState().setProcessStatus(secondSessionId, 'terminal')

    const state = useAppStore.getState()
    expect(state.codexLastResponse[firstSessionId]).toBe('Session A response')
    expect(state.codexLastResponse[secondSessionId]).toBe('Session B response')
    expect(state.sessionNeedsUserInput[firstSessionId]).toBe(true)
    expect(state.sessionNeedsUserInput[secondSessionId]).toBe(true)
  })
})
