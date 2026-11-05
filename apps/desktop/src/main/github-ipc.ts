// src/main/github-ipc.ts
//
// The desktop's PR view is the web app's PR page (apps/web/src/components/github),
// whose transport is a sync-hub `call`. A private hub holding only the GitHub
// handlers answers it over IPC, so both screens run the same validation and the
// same `gh` calls. Roots are checked against the saved workspaces, not the phone
// mirror: the mirror is empty whenever the phone server is down (port taken,
// failed start), and the view must still work then.

import { ipcMain } from 'electron'
import { registerGithubApi } from './local-server/api'
import { SyncHub } from './local-server/sync-hub'
import { loadPersistedData } from './persistence'

function assertWorkspaceRoot(rootDir: unknown): string {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir must be a string')
  const workspaces = Object.values(loadPersistedData()?.workspaces ?? {})
  if (workspaces.some((ws) => ws.trees.some((t) => t.rootDir === rootDir))) return rootDir
  throw new Error('Unknown worktree')
}

export function registerGithubIpc(): void {
  const hub = new SyncHub()
  registerGithubApi(hub, assertWorkspaceRoot)
  ipcMain.handle('github:call', (_event, name: unknown, args: unknown) => {
    if (typeof name !== 'string') throw new Error('name must be a string')
    return hub.invoke(name, args && typeof args === 'object' ? (args as Record<string, unknown>) : {})
  })
}
