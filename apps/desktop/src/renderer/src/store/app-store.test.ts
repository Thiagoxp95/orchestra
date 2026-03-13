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

  it('deletes sessions from non-active worktrees without leaving dangling tree references', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const firstTreeSessionId = useAppStore.getState().activeSessionId
    expect(firstTreeSessionId).toBeTruthy()
    if (!firstTreeSessionId) return

    useAppStore.getState().addWorktree(workspaceId, '/tmp/repo-feature')
    const secondTreeSessionId = useAppStore.getState().activeSessionId
    expect(secondTreeSessionId).toBeTruthy()
    if (!secondTreeSessionId) return

    useAppStore.getState().setActiveTree(workspaceId, 0)
    useAppStore.getState().deleteSession(secondTreeSessionId)

    const state = useAppStore.getState()
    expect(state.sessions[secondTreeSessionId]).toBeUndefined()
    expect(state.workspaces[workspaceId]?.trees[1]?.sessionIds).not.toContain(secondTreeSessionId)
    expect(state.workspaces[workspaceId]?.trees[0]?.sessionIds).toContain(firstTreeSessionId)
  })

  it('recreates missing session records when persisted trees still reference them', () => {
    useAppStore.getState().loadPersistedState(
      {
        'workspace-1': {
          id: 'workspace-1',
          name: 'Repo',
          color: '#111111',
          trees: [{ rootDir: '/tmp/repo', sessionIds: ['missing-session'] }],
          activeTreeIndex: 0,
          customActions: [],
          repositorySettings: { enabled: false },
          createdAt: 1,
        },
      },
      {},
      'workspace-1',
      'missing-session',
      { worktreesDir: '' },
      {},
      {},
    )

    const state = useAppStore.getState()
    expect(state.sessions['missing-session']).toMatchObject({
      id: 'missing-session',
      workspaceId: 'workspace-1',
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: '/tmp/repo',
    })
  })
})
