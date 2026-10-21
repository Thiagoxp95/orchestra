import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './app-store'
import type { CustomAction } from '../../../shared/types'

describe('session origin', () => {
  beforeEach(() => {
    const testWindow = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
    testWindow.window = testWindow as unknown as Window & typeof globalThis
    Object.assign(testWindow, {
      electronAPI: {
        prewarmTerminal: vi.fn(),
        codexSessionStarted: vi.fn(),
        getClaudeWorkState: vi.fn().mockResolvedValue(null),
        killTerminal: vi.fn(),
      },
    })
    useAppStore.setState({ workspaces: {}, sessions: {}, activeWorkspaceId: null, activeSessionId: null, settings: { worktreesDir: '' } })
  })

  it('leaves sessions the user opens without an origin (= user)', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const id = useAppStore.getState().createSession(workspaceId, undefined, undefined, undefined, undefined, 'claude')
    expect(useAppStore.getState().sessions[id].origin).toBeUndefined()
  })

  it('stamps origin mcp on sessions, actions and worktrees an agent asked for', () => {
    const workspaceId = useAppStore.getState().createWorkspace('Repo', '#111111', '/tmp/repo')
    const state = useAppStore.getState()
    const agent = state.createSession(workspaceId, undefined, undefined, undefined, undefined, 'claude', undefined, 0, undefined, 'mcp')
    const action: CustomAction = { id: 'a1', name: 'Dev', icon: 'Play', command: 'npm run dev' } as CustomAction
    const fromAction = state.runAction(workspaceId, action, { origin: 'mcp' })
    state.addWorktree(workspaceId, '/tmp/repo-wt', 'mcp')

    const { sessions, workspaces } = useAppStore.getState()
    const worktreeTerminal = workspaces[workspaceId].trees[1].sessionIds[0]
    expect(sessions[agent].origin).toBe('mcp')
    expect(sessions[fromAction].origin).toBe('mcp')
    expect(sessions[worktreeTerminal].origin).toBe('mcp')
  })
})
