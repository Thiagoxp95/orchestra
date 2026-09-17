import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  CustomAction,
  PersistedData,
  RepositoryWorkspaceSettings,
  Workspace,
} from '../shared/types'

const REPOSITORY_SETTINGS_DIR = '.orchestra'
const REPOSITORY_SETTINGS_FILE = 'workspace-settings.json'

export const REPOSITORY_SETTINGS_RELATIVE_PATH = path.join(
  REPOSITORY_SETTINGS_DIR,
  REPOSITORY_SETTINGS_FILE,
)

function getRepositorySettingsPath(rootDir: string): string {
  return path.join(rootDir, REPOSITORY_SETTINGS_RELATIVE_PATH)
}

function getWorkspaceRootDir(workspace: Workspace): string | null {
  return workspace.trees[0]?.rootDir ?? workspace.trees[workspace.activeTreeIndex]?.rootDir ?? null
}

// Per-user fields never go in the committed file: a shared schedule would run once per teammate,
// and webhook tokens are personal.
const LOCAL_ONLY_ACTION_KEYS = [
  'schedule',
  'automationEnabled',
  'persistWhenClosed',
  'automationTargetTreeIndex',
  'webhookToken',
  'webhookUrl',
  'webhookFilter',
] as const satisfies readonly (keyof CustomAction)[]

function toSharedAction(action: CustomAction): CustomAction {
  const shared = { ...action }
  for (const key of LOCAL_ONLY_ACTION_KEYS) delete shared[key]
  return shared
}

function withLocalFields(shared: CustomAction[], local: CustomAction[]): CustomAction[] {
  const localById = new Map(local.map((action) => [action.id, action]))
  return shared.map((action) => {
    const localAction = localById.get(action.id)
    const merged = { ...action }
    if (!localAction) return merged
    for (const key of LOCAL_ONLY_ACTION_KEYS) {
      if (localAction[key] !== undefined) Object.assign(merged, { [key]: localAction[key] })
    }
    return merged
  })
}

function isCustomAction(value: unknown): value is CustomAction {
  if (!value || typeof value !== 'object') return false
  const action = value as Record<string, unknown>
  return (
    typeof action.id === 'string' &&
    typeof action.name === 'string' &&
    typeof action.icon === 'string' &&
    typeof action.command === 'string' &&
    typeof action.keybinding === 'string' &&
    typeof action.runOnWorktreeCreation === 'boolean'
  )
}

function sanitizeRepositoryWorkspaceSettings(value: unknown): RepositoryWorkspaceSettings | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Record<string, unknown>
  const color = typeof candidate.color === 'string' ? candidate.color : undefined
  const customActions = Array.isArray(candidate.customActions)
    ? candidate.customActions.filter(isCustomAction).map(toSharedAction)
    : undefined

  return {
    version: 1,
    ...(color ? { color } : {}),
    ...(customActions ? { customActions } : {}),
  }
}

function pruneRepositorySettingsDirectory(rootDir: string): void {
  const dirPath = path.join(rootDir, REPOSITORY_SETTINGS_DIR)
  try {
    const entries = fs.readdirSync(dirPath)
    if (entries.length === 0) {
      fs.rmdirSync(dirPath)
    }
  } catch {
    // Ignore missing directories and permission issues here.
  }
}

export function repositorySettingsFromWorkspace(workspace: Workspace): RepositoryWorkspaceSettings {
  return {
    version: 1,
    color: workspace.color,
    customActions: workspace.customActions.map(toSharedAction),
  }
}

export function loadRepositoryWorkspaceSettings(rootDir: string): RepositoryWorkspaceSettings | null {
  if (!rootDir) return null

  try {
    const raw = fs.readFileSync(getRepositorySettingsPath(rootDir), 'utf8')
    return sanitizeRepositoryWorkspaceSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveRepositoryWorkspaceSettings(
  rootDir: string,
  settings: RepositoryWorkspaceSettings | null,
): void {
  if (!rootDir) return

  const filePath = getRepositorySettingsPath(rootDir)
  if (settings?.customActions) {
    settings = { ...settings, customActions: settings.customActions.map(toSharedAction) }
  }
  if (!settings) {
    try {
      fs.rmSync(filePath, { force: true })
      pruneRepositorySettingsDirectory(rootDir)
    } catch {
      // Ignore deletes for missing files.
    }
    return
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  fs.renameSync(`${filePath}.tmp`, filePath)
}

export function applyRepositorySettingsToWorkspace(
  workspace: Workspace,
  settings: RepositoryWorkspaceSettings | null,
): Workspace {
  if (!settings) {
    return {
      ...workspace,
      repositorySettings: { enabled: false },
    }
  }

  return {
    ...workspace,
    color: settings.color ?? workspace.color,
    customActions: settings.customActions
      ? withLocalFields(settings.customActions, workspace.customActions)
      : workspace.customActions,
    repositorySettings: { enabled: true },
  }
}

export function mergeRepositorySettingsIntoPersistedData(data: PersistedData): PersistedData {
  const workspaces = Object.fromEntries(
    Object.entries(data.workspaces).map(([id, workspace]) => {
      const rootDir = getWorkspaceRootDir(workspace)
      const settings = rootDir ? loadRepositoryWorkspaceSettings(rootDir) : null
      return [id, applyRepositorySettingsToWorkspace(workspace, settings)]
    }),
  )

  return {
    ...data,
    workspaces,
  }
}

export function syncRepositoryWorkspaceSettings(
  workspaces: Record<string, Workspace>,
  previousWorkspaces: Record<string, Workspace> = {},
): void {
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    const previousWorkspace = previousWorkspaces[workspaceId]
    const rootDir = getWorkspaceRootDir(workspace)
    const previousRootDir = previousWorkspace ? getWorkspaceRootDir(previousWorkspace) : null
    const enabled = workspace.repositorySettings?.enabled === true
    const wasEnabled = previousWorkspace?.repositorySettings?.enabled === true

    if (enabled && rootDir) {
      saveRepositoryWorkspaceSettings(rootDir, repositorySettingsFromWorkspace(workspace))
      if (wasEnabled && previousRootDir && previousRootDir !== rootDir) {
        saveRepositoryWorkspaceSettings(previousRootDir, null)
      }
      continue
    }

    if (wasEnabled) {
      const deleteRootDir = previousRootDir ?? rootDir
      if (deleteRootDir) {
        saveRepositoryWorkspaceSettings(deleteRootDir, null)
      }
    }
  }
}
