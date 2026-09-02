import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './app-store'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_PRINT_COMMAND_PREVIEW,
} from '../../../shared/action-utils'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

function normalizedCodexState(
  sessionId: string,
  state: NormalizedAgentSessionStatus['state'],
): NormalizedAgentSessionStatus {
  return {
    sessionId,
    agent: 'codex',
    state,
    authority: 'codex-hook',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: 0,
    updatedAt: 0,
  }
}

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
    pendingSessionClose: null,
  })
}

describe('app-store agent sidebar state', () => {
  beforeEach(() => {
    const testWindow = globalThis as typeof globalThis & { window?: Window & typeof globalThis, electronAPI?: unknown }
    testWindow.window = testWindow as unknown as Window & typeof globalThis
    Object.assign(testWindow, {
      electronAPI: {
        codexSessionStarted: vi.fn(),
        getClaudeWorkState: vi.fn().mockResolvedValue(null),
        killTerminal: vi.fn(),
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
    // "Idle" is the work state, not the launch: an interactive session is still
    // an agent starting up, and the unconfirmed launch entry is what says so
    // while process-monitor can't see the agent in `ps` yet. What must NOT be
    // set here is the work state — a launch is not a run.
    expect(state.agentLaunches[claudeSessionId]).toMatchObject({
      agent: 'claude',
      confirmed: false,
    })
    expect(state.agentLaunches[codexSessionId]).toMatchObject({
      agent: 'codex',
      confirmed: false,
    })
  })

  // The terminal-flash regression: a session created as an agent used to have no
  // launch record unless it auto-started a run, so process-monitor's first poll
  // — taken before the PTY's shell had exec'd the agent — downgraded it to
  // 'terminal' and the pane painted the raw grid for a poll or two before
  // flipping to chat.
  it('records the launch intent for every agent session, whatever it was launched with', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')

    const bareClaudeId = useAppStore.getState().createSession(
      workspaceId,
      undefined,
      undefined,
      '__claude__',
      'Claude',
      'claude',
    )
    const shellId = useAppStore.getState().createSession(workspaceId)

    const state = useAppStore.getState()
    expect(state.agentLaunches[bareClaudeId]).toMatchObject({ agent: 'claude', confirmed: false })
    expect(state.agentLaunches[bareClaudeId]?.startedAt).toBeTypeOf('number')
    // A plain shell is not an agent launch — it must keep ignoring the chat
    // preference rather than being covered by an empty timeline.
    expect(state.agentLaunches[shellId]).toBeUndefined()
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

  it('mirrors normalized Codex state into legacy codexWorkState diagnostics', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().createSession(
      workspaceId,
      CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
      undefined,
      '__openai__',
      'Codex',
      'codex',
    )

    useAppStore.getState().setCodexWorkState(sessionId, 'working')
    useAppStore.getState().setNormalizedAgentState(normalizedCodexState(sessionId, 'idle'))

    const state = useAppStore.getState()
    expect(state.normalizedAgentState[sessionId]?.state).toBe('idle')
    expect(state.codexWorkState[sessionId]).toBe('idle')
  })

  it('does not mark Claude as working until Claude emits source-backed activity', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().createSession(
      workspaceId,
      CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
      undefined,
      '__claude__',
      'Claude',
      'claude',
    )

    useAppStore.getState().startAgentRun(sessionId)

    const state = useAppStore.getState()
    expect(state.claudeWorkState[sessionId]).toBe('idle')
    expect(state.agentLaunches[sessionId]).toMatchObject({
      agent: 'claude',
      confirmed: false,
    })
  })

  it('resyncs claudeWorkState from main when prompts queue into a thinking Claude', async () => {
    const testWindow = globalThis as typeof globalThis & { electronAPI: { getClaudeWorkState: ReturnType<typeof vi.fn> } }
    testWindow.electronAPI.getClaudeWorkState.mockResolvedValueOnce('working')

    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().createSession(
      workspaceId,
      CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
      undefined,
      '__claude__',
      'Claude',
      'claude',
    )

    useAppStore.getState().startAgentRun(sessionId)

    expect(useAppStore.getState().claudeWorkState[sessionId]).toBe('idle')
    expect(testWindow.electronAPI.getClaudeWorkState).toHaveBeenCalledWith(sessionId)

    await Promise.resolve()
    await Promise.resolve()

    expect(useAppStore.getState().claudeWorkState[sessionId]).toBe('working')
  })

  it('does not clobber a newer launch when an older resync resolves', async () => {
    const testWindow = globalThis as typeof globalThis & { electronAPI: { getClaudeWorkState: ReturnType<typeof vi.fn> } }
    let resolveFirst: (value: 'working' | null) => void = () => {}
    testWindow.electronAPI.getClaudeWorkState.mockImplementationOnce(
      () => new Promise<'working' | null>((resolve) => { resolveFirst = resolve })
    )
    testWindow.electronAPI.getClaudeWorkState.mockResolvedValueOnce(null)

    let nowCounter = 1000
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowCounter++)

    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().createSession(
      workspaceId,
      CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
      undefined,
      '__claude__',
      'Claude',
      'claude',
    )

    useAppStore.getState().startAgentRun(sessionId)
    // Simulate a second prompt submission while the first resync is still pending
    useAppStore.getState().startAgentRun(sessionId)

    // Now resolve the first resync as 'working' — it should be ignored because
    // the agentLaunch.startedAt no longer matches.
    resolveFirst('working')
    await Promise.resolve()
    await Promise.resolve()

    expect(useAppStore.getState().claudeWorkState[sessionId]).toBe('idle')
    dateNowSpy.mockRestore()
  })

  it('clears stale Claude sidebar state when a reused terminal becomes a Claude session', () => {
    useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const sessionId = useAppStore.getState().activeSessionId
    expect(sessionId).toBeTruthy()
    if (!sessionId) return

    useAppStore.setState((state) => ({
      claudeWorkState: { ...state.claudeWorkState, [sessionId]: 'working' },
      claudeLastResponse: { ...state.claudeLastResponse, [sessionId]: 'Stale preview' },
      normalizedAgentState: {
        ...state.normalizedAgentState,
        [sessionId]: {
          sessionId,
          agent: 'claude',
          state: 'working',
          authority: 'codex-watcher-fallback',
          connected: true,
          lastResponsePreview: 'Stale preview',
          lastTransitionAt: 1,
          updatedAt: 1,
        },
      },
    }))

    useAppStore.getState().setProcessStatus(sessionId, 'claude')

    const state = useAppStore.getState()
    expect(state.sessions[sessionId]?.processStatus).toBe('claude')
    expect(state.claudeWorkState[sessionId]).toBe('idle')
    expect(state.claudeLastResponse[sessionId]).toBe('')
    expect(state.normalizedAgentState[sessionId]).toBeUndefined()
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

  it('stores worktree display names without changing the root directory or sessions', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    useAppStore.getState().addWorktree(workspaceId, '/tmp/repo-eng-4547')
    const originalSessionIds = useAppStore.getState().workspaces[workspaceId]?.trees[1]?.sessionIds

    useAppStore.getState().updateWorktreeDisplayName(workspaceId, 1, 'Fix submission flow')

    let tree = useAppStore.getState().workspaces[workspaceId]?.trees[1]
    expect(tree).toMatchObject({
      rootDir: '/tmp/repo-eng-4547',
      displayName: 'Fix submission flow',
    })
    expect(tree?.sessionIds).toEqual(originalSessionIds)

    useAppStore.getState().updateWorktreeDisplayName(workspaceId, 1, '   ')

    tree = useAppStore.getState().workspaces[workspaceId]?.trees[1]
    expect(tree?.displayName).toBeUndefined()
    expect(tree?.rootDir).toBe('/tmp/repo-eng-4547')
    expect(tree?.sessionIds).toEqual(originalSessionIds)
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

describe('app-store pin, rename and close confirmation', () => {
  beforeEach(() => {
    const testWindow = globalThis as typeof globalThis & { window?: Window & typeof globalThis, electronAPI?: unknown }
    testWindow.window = testWindow as unknown as Window & typeof globalThis
    Object.assign(testWindow, { electronAPI: { killTerminal: vi.fn() } })
    resetStore()
    useAppStore.setState({
      workspaces: {
        'workspace-1': {
          id: 'workspace-1',
          name: 'Repo',
          color: '#111111',
          trees: [{ rootDir: '/tmp/repo', sessionIds: ['s1', 's2'] }],
          activeTreeIndex: 0,
          customActions: [],
          createdAt: 1,
        },
      },
      sessions: {
        s1: { id: 's1', workspaceId: 'workspace-1', label: 'the last prompt I sent', processStatus: 'claude', cwd: '/tmp/repo', shellPath: '/bin/zsh' },
        s2: { id: 's2', workspaceId: 'workspace-1', label: 'Terminal 1', processStatus: 'terminal', cwd: '/tmp/repo', shellPath: '/bin/zsh' },
      },
      activeWorkspaceId: 'workspace-1',
      activeSessionId: 's1',
    })
  })

  it('pins and unpins, dropping the flag entirely when unpinned', () => {
    useAppStore.getState().setSessionPinned('s1', true)
    expect(useAppStore.getState().sessions.s1.pinned).toBe(true)

    useAppStore.getState().setSessionPinned('s1', false)
    expect(useAppStore.getState().sessions.s1.pinned).toBeUndefined()
  })

  it('renames without disturbing the auto label, so clearing falls back to it', () => {
    useAppStore.getState().renameSession('s1', '  Release cut  ')
    expect(useAppStore.getState().sessions.s1).toMatchObject({
      customLabel: 'Release cut',
      label: 'the last prompt I sent',
    })

    useAppStore.getState().renameSession('s1', '   ')
    expect(useAppStore.getState().sessions.s1.customLabel).toBeUndefined()
  })

  it('keeps the rename after the auto label moves on', () => {
    useAppStore.getState().renameSession('s1', 'Release cut')
    useAppStore.getState().updateSessionLabel('s1', 'a newer prompt')
    expect(useAppStore.getState().sessions.s1).toMatchObject({
      customLabel: 'Release cut',
      label: 'a newer prompt',
    })
  })

  it('closes an unpinned session on the spot, with no dialog', () => {
    useAppStore.getState().requestSessionClose(['s1', 'ghost'], 'the last prompt I sent')
    expect(useAppStore.getState().pendingSessionClose).toBeNull()
    expect(useAppStore.getState().sessions.s1).toBeUndefined()
  })

  it('parks a pinned close request instead of deleting, and drops ids that are already gone', () => {
    useAppStore.getState().setSessionPinned('s1', true)
    useAppStore.getState().requestSessionClose(['s1', 'ghost'], 'the last prompt I sent')
    expect(useAppStore.getState().pendingSessionClose).toEqual({
      sessionIds: ['s1'],
      label: 'the last prompt I sent',
    })
    // Nothing is closed until the dialog confirms it.
    expect(useAppStore.getState().sessions.s1).toBeDefined()

    useAppStore.getState().cancelSessionClose()
    expect(useAppStore.getState().pendingSessionClose).toBeNull()
  })

  it('closes the unpinned half of a mixed request and asks about the pinned rest', () => {
    useAppStore.getState().setSessionPinned('s1', true)

    useAppStore.getState().requestSessionClose(['s1', 's2'], 'two sessions')
    expect(useAppStore.getState().sessions.s2).toBeUndefined()
    expect(useAppStore.getState().pendingSessionClose).toEqual({
      sessionIds: ['s1'],
      label: 'two sessions',
    })
  })

  it('never opens a dialog for a request with nothing left to close', () => {
    useAppStore.getState().requestSessionClose(['ghost'], 'gone')
    expect(useAppStore.getState().pendingSessionClose).toBeNull()
  })
})

