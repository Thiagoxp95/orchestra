import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './app-store'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_PRINT_COMMAND_PREVIEW,
} from '../../../shared/action-utils'

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
    normalizedAgentState: {},
    agentLaunches: {},
    deletingWorktrees: new Set<string>(),
  })
}

describe('app-store agent sidebar state', () => {
  beforeEach(() => {
    Object.assign(window, {
      electronAPI: {
        claudeSessionStarted: vi.fn(),
        codexSessionStarted: vi.fn(),
      },
    })
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

  it('keeps interactive agent sessions idle until a run is submitted', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')

    const claudeSessionId = useAppStore.getState().createSession(
      workspaceId,
      CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
      undefined,
      '__claude__',
      'Claude',
      'claude',
    )
    const codexSessionId = useAppStore.getState().createSession(
      workspaceId,
      CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
      undefined,
      '__openai__',
      'Codex',
      'codex',
    )

    const state = useAppStore.getState()
    expect(state.claudeWorkState[claudeSessionId]).toBe('idle')
    expect(state.codexWorkState[codexSessionId]).toBe('idle')
    expect(state.agentLaunches[claudeSessionId]).toBeUndefined()
    expect(state.agentLaunches[codexSessionId]).toBeUndefined()
  })

  it('starts working immediately for non-interactive agent launches', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')

    const codexSessionId = useAppStore.getState().createSession(
      workspaceId,
      CODEX_PRINT_COMMAND_PREVIEW,
      undefined,
      '__openai__',
      'Codex',
      'codex',
    )

    const state = useAppStore.getState()
    expect(state.codexWorkState[codexSessionId]).toBe('working')
    expect(state.agentLaunches[codexSessionId]).toMatchObject({
      agent: 'codex',
      confirmed: false,
    })
  })

  it('marks an interactive agent session as working only after startAgentRun', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().createSession(
      workspaceId,
      CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
      undefined,
      '__openai__',
      'Codex',
      'codex',
    )

    useAppStore.getState().startAgentRun(sessionId)

    const state = useAppStore.getState()
    expect(state.codexWorkState[sessionId]).toBe('working')
    expect(state.agentLaunches[sessionId]).toMatchObject({
      agent: 'codex',
      confirmed: false,
    })
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

  it('restores the last selected session when returning to a workspace', () => {
    const firstWorkspaceId = useAppStore.getState().createWorkspace('Repo A', '#111111', '/tmp/repo-a')
    const secondSessionId = useAppStore.getState().createSession(firstWorkspaceId)
    const thirdSessionId = useAppStore.getState().createSession(firstWorkspaceId)

    expect(useAppStore.getState().activeSessionId).toBe(thirdSessionId)

    const secondWorkspaceId = useAppStore.getState().createWorkspace('Repo B', '#222222', '/tmp/repo-b')
    expect(useAppStore.getState().activeWorkspaceId).toBe(secondWorkspaceId)

    useAppStore.getState().setActiveWorkspace(firstWorkspaceId)

    const state = useAppStore.getState()
    expect(state.activeWorkspaceId).toBe(firstWorkspaceId)
    expect(state.activeSessionId).toBe(thirdSessionId)
    expect(state.workspaces[firstWorkspaceId]?.lastActiveSessionId).toBe(thirdSessionId)
    expect(state.workspaces[firstWorkspaceId]?.trees[0]?.sessionIds).toEqual([
      expect.any(String),
      secondSessionId,
      thirdSessionId,
    ])
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

  it('kills all sessions only in the targeted inactive worktree', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const firstTreeSessionId = useAppStore.getState().activeSessionId
    expect(firstTreeSessionId).toBeTruthy()
    if (!firstTreeSessionId) return

    useAppStore.getState().addWorktree(workspaceId, '/tmp/repo-feature')
    const secondTreeSessionId = useAppStore.getState().activeSessionId
    expect(secondTreeSessionId).toBeTruthy()
    if (!secondTreeSessionId) return

    useAppStore.getState().setActiveTree(workspaceId, 0)
    useAppStore.getState().deleteAllSessions(workspaceId, 1)

    const state = useAppStore.getState()
    const activeTreeIds = state.workspaces[workspaceId]?.trees[0]?.sessionIds ?? []
    const inactiveTreeIds = state.workspaces[workspaceId]?.trees[1]?.sessionIds ?? []

    expect(activeTreeIds).toEqual([firstTreeSessionId])
    expect(inactiveTreeIds).toHaveLength(1)
    expect(inactiveTreeIds[0]).not.toBe(secondTreeSessionId)
    expect(state.sessions[firstTreeSessionId]).toBeDefined()
    expect(state.sessions[secondTreeSessionId]).toBeUndefined()
    expect(state.activeSessionId).toBe(firstTreeSessionId)
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

  it('repairs runtime tree references when a session record disappears', () => {
    useAppStore.setState({
      workspaces: {
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
      sessions: {},
      activeWorkspaceId: 'workspace-1',
      activeSessionId: 'missing-session',
    })

    useAppStore.getState().repairSessionConsistency()

    const state = useAppStore.getState()
    expect(state.sessions['missing-session']).toMatchObject({
      id: 'missing-session',
      workspaceId: 'workspace-1',
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: '/tmp/repo',
    })
    expect(state.activeWorkspaceId).toBe('workspace-1')
    expect(state.activeSessionId).toBe('missing-session')
  })
})
