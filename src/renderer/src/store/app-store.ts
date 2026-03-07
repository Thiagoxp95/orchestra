import { create } from 'zustand'
import type { Workspace, TerminalSession, ProcessStatus } from '../../../shared/types'

function generateId(): string {
  return crypto.randomUUID()
}

interface AppState {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession>
  activeWorkspaceId: string | null
  activeSessionId: string | null

  createWorkspace: (name: string, color: string) => string
  deleteWorkspace: (id: string) => void
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name' | 'color'>>) => void
  createSession: (workspaceId: string) => string
  deleteSession: (id: string) => void
  setActiveWorkspace: (id: string) => void
  setActiveSession: (id: string) => void
  setProcessStatus: (sessionId: string, status: ProcessStatus) => void
  loadPersistedState: (
    workspaces: Record<string, Workspace>,
    sessions: Record<string, TerminalSession>,
    activeWorkspaceId: string | null,
    activeSessionId: string | null
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: {},
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,

  createWorkspace: (name, color) => {
    const id = generateId()
    const sessionId = generateId()
    const workspace: Workspace = {
      id,
      name,
      color,
      sessionIds: [sessionId],
      createdAt: Date.now()
    }
    const session: TerminalSession = {
      id: sessionId,
      workspaceId: id,
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: '~',
      shellPath: ''
    }
    set((state) => ({
      workspaces: { ...state.workspaces, [id]: workspace },
      sessions: { ...state.sessions, [sessionId]: session },
      activeWorkspaceId: id,
      activeSessionId: sessionId
    }))
    return id
  },

  deleteWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      const newSessions = { ...state.sessions }
      for (const sid of workspace.sessionIds) {
        delete newSessions[sid]
      }
      const newWorkspaces = { ...state.workspaces }
      delete newWorkspaces[id]
      const remainingIds = Object.keys(newWorkspaces)
      return {
        workspaces: newWorkspaces,
        sessions: newSessions,
        activeWorkspaceId:
          state.activeWorkspaceId === id
            ? (remainingIds[0] ?? null)
            : state.activeWorkspaceId,
        activeSessionId:
          state.activeWorkspaceId === id
            ? (newWorkspaces[remainingIds[0]]?.sessionIds[0] ?? null)
            : state.activeSessionId
      }
    })
  },

  updateWorkspace: (id, updates) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      return {
        workspaces: {
          ...state.workspaces,
          [id]: { ...workspace, ...updates }
        }
      }
    })
  },

  createSession: (workspaceId) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const sessionId = generateId()
    const sessionCount = workspace.sessionIds.length + 1
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: `Terminal ${sessionCount}`,
      processStatus: 'terminal',
      cwd: '~',
      shellPath: ''
    }
    set((s) => ({
      workspaces: {
        ...s.workspaces,
        [workspaceId]: {
          ...s.workspaces[workspaceId],
          sessionIds: [...s.workspaces[workspaceId].sessionIds, sessionId]
        }
      },
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId
    }))
    return sessionId
  },

  deleteSession: (id) => {
    set((state) => {
      const session = state.sessions[id]
      if (!session) return state
      const workspace = state.workspaces[session.workspaceId]
      if (!workspace) return state
      const newSessionIds = workspace.sessionIds.filter((sid) => sid !== id)
      const newSessions = { ...state.sessions }
      delete newSessions[id]
      const newActiveSessionId =
        state.activeSessionId === id
          ? (newSessionIds[0] ?? null)
          : state.activeSessionId
      return {
        workspaces: {
          ...state.workspaces,
          [session.workspaceId]: { ...workspace, sessionIds: newSessionIds }
        },
        sessions: newSessions,
        activeSessionId: newActiveSessionId
      }
    })
  },

  setActiveWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      return {
        activeWorkspaceId: id,
        activeSessionId: workspace?.sessionIds[0] ?? null
      }
    })
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id })
  },

  setProcessStatus: (sessionId, status) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, processStatus: status }
        }
      }
    })
  },

  loadPersistedState: (workspaces, sessions, activeWorkspaceId, activeSessionId) => {
    set({ workspaces, sessions, activeWorkspaceId, activeSessionId })
  }
}))
