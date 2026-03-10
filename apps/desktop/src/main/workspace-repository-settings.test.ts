import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedData, Workspace } from '../shared/types'
import {
  REPOSITORY_SETTINGS_RELATIVE_PATH,
  loadRepositoryWorkspaceSettings,
  mergeRepositorySettingsIntoPersistedData,
  saveRepositoryWorkspaceSettings,
  syncRepositoryWorkspaceSettings,
} from './workspace-repository-settings'

const tempDirs: string[] = []

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-repo-settings-'))
  tempDirs.push(dir)
  return dir
}

function makeWorkspace(id: string, rootDir: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    color: '#223344',
    trees: [{ rootDir, sessionIds: ['session-1'] }],
    activeTreeIndex: 0,
    customActions: [
      {
        id: 'default-terminal',
        name: 'Terminal',
        icon: '__terminal__',
        command: '',
        keybinding: 'Cmd+J',
        runOnWorktreeCreation: false,
        actionType: 'cli',
        isDefault: true,
      },
    ],
    repositorySettings: { enabled: false },
    createdAt: 1,
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('repository workspace settings', () => {
  it('saves and loads the shared workspace file', () => {
    const repoDir = makeTempRepo()

    saveRepositoryWorkspaceSettings(repoDir, {
      version: 1,
      color: '#ff6600',
      customActions: [
        {
          id: 'ship-it',
          name: 'Ship it',
          icon: '__terminal__',
          command: 'bun test',
          keybinding: 'Cmd+Shift+T',
          runOnWorktreeCreation: false,
          actionType: 'cli',
        },
      ],
    })

    const savedPath = path.join(repoDir, REPOSITORY_SETTINGS_RELATIVE_PATH)
    expect(fs.existsSync(savedPath)).toBe(true)
    expect(loadRepositoryWorkspaceSettings(repoDir)).toEqual({
      version: 1,
      color: '#ff6600',
      customActions: [
        {
          id: 'ship-it',
          name: 'Ship it',
          icon: '__terminal__',
          command: 'bun test',
          keybinding: 'Cmd+Shift+T',
          runOnWorktreeCreation: false,
          actionType: 'cli',
        },
      ],
    })
  })

  it('merges repository settings into persisted workspaces', () => {
    const repoDir = makeTempRepo()
    saveRepositoryWorkspaceSettings(repoDir, {
      version: 1,
      color: '#44aa88',
      customActions: [
        {
          id: 'shared-action',
          name: 'Shared action',
          icon: '__openai__',
          command: 'codex --full-auto',
          keybinding: 'Cmd+O',
          runOnWorktreeCreation: false,
          actionType: 'codex',
        },
      ],
    })

    const persisted: PersistedData = {
      workspaces: {
        ws1: makeWorkspace('ws1', repoDir),
      },
      sessions: {},
      activeWorkspaceId: 'ws1',
      activeSessionId: null,
      settings: { worktreesDir: '' },
      claudeLastResponse: {},
      codexLastResponse: {},
    }

    const merged = mergeRepositorySettingsIntoPersistedData(persisted)

    expect(merged.workspaces.ws1.color).toBe('#44aa88')
    expect(merged.workspaces.ws1.customActions[0]?.id).toBe('shared-action')
    expect(merged.workspaces.ws1.repositorySettings?.enabled).toBe(true)
  })

  it('removes the shared file when repository settings are disabled', () => {
    const repoDir = makeTempRepo()
    saveRepositoryWorkspaceSettings(repoDir, {
      version: 1,
      color: '#123456',
      customActions: [],
    })

    const previousWorkspace = makeWorkspace('ws1', repoDir, {
      repositorySettings: { enabled: true },
    })
    const currentWorkspace = makeWorkspace('ws1', repoDir, {
      repositorySettings: { enabled: false },
    })

    syncRepositoryWorkspaceSettings(
      { ws1: currentWorkspace },
      { ws1: previousWorkspace },
    )

    expect(fs.existsSync(path.join(repoDir, REPOSITORY_SETTINGS_RELATIVE_PATH))).toBe(false)
  })
})
