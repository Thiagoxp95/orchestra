// Merges orchestra's managed entries into ~/.codex/hooks.json (UserPromptSubmit
// + Stop) so codex fires our notify script without per-launch wrapping. User
// hooks and unrelated events are preserved; re-runs are idempotent.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CODEX_NOTIFY_SCRIPT_NAME, ensureCodexNotifyScript } from './codex-notify-script'

// Older orchestra builds shipped a shell wrapper at ~/.orchestra*/bin/codex
// that tailed the codex TUI session log itself and leaked watcher subshells.
// We detect those by signature and remove them on startup so users don't get
// stuck running a bug-fixed-only-in-source wrapper.
const LEGACY_WRAPPER_MARKERS = [
  'Orchestra Codex wrapper',
  'ORCHESTRA_CODEX_WATCHER_PID',
  'find_real_binary',
] as const

interface CodexHookCommand {
  type?: string
  command?: string
  [key: string]: unknown
}

interface CodexHookDefinition {
  matcher?: string
  hooks?: CodexHookCommand[]
  [key: string]: unknown
}

interface CodexHooksJson {
  hooks?: Record<string, CodexHookDefinition[]>
  [key: string]: unknown
}

const MANAGED_EVENT_NAMES = ['UserPromptSubmit', 'Stop'] as const
type ManagedEventName = (typeof MANAGED_EVENT_NAMES)[number]

export function getCodexGlobalHooksPath(home: string = os.homedir()): string {
  return path.join(home, '.codex', 'hooks.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHooksJson(globalPath: string): CodexHooksJson | null {
  if (!fs.existsSync(globalPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf8'))
    return isPlainObject(parsed) ? (parsed as CodexHooksJson) : null
  } catch (error) {
    console.warn('[codex-hooks-setup] Failed to parse', globalPath, error)
    return null
  }
}

function isManagedCommand(command: string | undefined, notifyPath: string): boolean {
  if (!command) return false
  // Exact match for our notify path, or a path ending in our well-known script
  // name (covers dev/prod environment switches under different ORCHESTRA_HOME).
  if (command === notifyPath) return true
  return command.endsWith(`/${CODEX_NOTIFY_SCRIPT_NAME}`)
}

function stripManagedFromDefinition(
  definition: CodexHookDefinition,
  notifyPath: string,
): CodexHookDefinition | null {
  if (!Array.isArray(definition.hooks)) return definition
  const filtered = definition.hooks.filter((hook) => !isManagedCommand(hook.command, notifyPath))
  if (filtered.length === definition.hooks.length) return definition
  if (filtered.length === 0) return null
  return { ...definition, hooks: filtered }
}

function buildManagedDefinition(notifyPath: string): CodexHookDefinition {
  return {
    hooks: [{ type: 'command', command: notifyPath }],
  }
}

/**
 * Returns the merged hooks.json content with orchestra's managed entries, or
 * `null` when the existing file is unparseable (we refuse to clobber user data).
 */
export function buildCodexHooksJsonContent(
  existing: CodexHooksJson | null,
  notifyPath: string,
): string | null {
  if (existing === null) return null
  const next: CodexHooksJson = { ...existing }
  const hooksField = isPlainObject(next.hooks) ? { ...next.hooks } : {}

  // First, strip ANY stale orchestra-managed entries across all events (covers
  // the case where we previously registered events we no longer manage).
  for (const eventName of Object.keys(hooksField)) {
    const current = hooksField[eventName]
    if (!Array.isArray(current)) continue
    const filtered = current
      .map((def) => stripManagedFromDefinition(def, notifyPath))
      .filter((def): def is CodexHookDefinition => def !== null)
    if (filtered.length === 0) {
      delete hooksField[eventName]
    } else {
      hooksField[eventName] = filtered
    }
  }

  // Then, append a fresh managed entry for each event we currently manage.
  const managed = buildManagedDefinition(notifyPath)
  for (const eventName of MANAGED_EVENT_NAMES as readonly ManagedEventName[]) {
    const current = hooksField[eventName]
    hooksField[eventName] = Array.isArray(current) ? [...current, managed] : [managed]
  }

  next.hooks = hooksField
  return JSON.stringify(next, null, 2) + '\n'
}

export interface EnsureCodexHooksResult {
  notifyPath: string
  hooksPath: string
  hooksChanged: boolean
  scriptChanged: boolean
  /** Stale legacy artifacts that were removed during this run. */
  removedLegacyArtifacts: string[]
}

/** Lists candidate paths for a stale wrapper, regardless of dev/prod context. */
function legacyWrapperCandidates(home: string): string[] {
  return [
    path.join(home, '.orchestra', 'bin', 'codex'),
    path.join(home, '.orchestra-dev', 'bin', 'codex'),
  ]
}

/** Lists candidate session-log directories left behind by the legacy wrapper. */
function legacySessionLogDirs(home: string): string[] {
  return [
    path.join(home, '.orchestra', 'hooks', 'codex-sessions'),
    path.join(home, '.orchestra-dev', 'hooks', 'codex-sessions'),
  ]
}

function isLegacyWrapperFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    // Cap how much we read — these wrappers are only a few KB, but we don't
    // want to slurp a giant unrelated file someone parked at this path.
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(8 * 1024)
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
      const head = buf.slice(0, bytes).toString('utf8')
      return LEGACY_WRAPPER_MARKERS.some((marker) => head.includes(marker))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

export function removeLegacyCodexArtifacts(home: string = os.homedir()): string[] {
  const removed: string[] = []

  for (const candidate of legacyWrapperCandidates(home)) {
    if (!isLegacyWrapperFile(candidate)) continue
    try {
      fs.unlinkSync(candidate)
      removed.push(candidate)
    } catch (error) {
      console.warn('[codex-hooks-setup] failed to remove legacy wrapper', candidate, error)
    }
  }

  for (const dir of legacySessionLogDirs(home)) {
    if (!fs.existsSync(dir)) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      console.warn('[codex-hooks-setup] failed to remove legacy session dir', dir, error)
    }
  }

  return removed
}

/** Writes the notify script, then merges hook entries into ~/.codex/hooks.json. */
export function ensureCodexHooksRegistered(opts: {
  home?: string
  env?: NodeJS.ProcessEnv
} = {}): EnsureCodexHooksResult | null {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const removedLegacyArtifacts = removeLegacyCodexArtifacts(home)
  const { path: notifyPath, changed: scriptChanged } = ensureCodexNotifyScript(env)

  const hooksPath = getCodexGlobalHooksPath(home)
  const existing = readHooksJson(hooksPath)
  const content = buildCodexHooksJsonContent(existing, notifyPath)
  if (content === null) {
    console.warn('[codex-hooks-setup] refusing to overwrite unparseable', hooksPath)
    return null
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true })
  const previous = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : null
  if (previous === content) {
    return { notifyPath, hooksPath, hooksChanged: false, scriptChanged, removedLegacyArtifacts }
  }

  fs.writeFileSync(hooksPath, content, { mode: 0o644 })
  return { notifyPath, hooksPath, hooksChanged: true, scriptChanged, removedLegacyArtifacts }
}
