// Merges orchestra's managed entries into ~/.cursor/hooks.json so the Cursor
// CLI fires our notify script without per-launch wrapping. Mirrors
// codex-hooks-setup.ts; cursor's format differs in two ways: event names are
// camelCase, and each entry is a flat `{command, timeout}` rather than a
// `{hooks: [...]}` group. The file also carries a top-level `version`.
// Other tools' hooks and unrelated events are preserved; re-runs are
// idempotent; an unparseable file is never overwritten.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureCursorNotifyScript } from './cursor-notify-script'

interface CursorHookEntry {
  command?: string
  timeout?: number
  [key: string]: unknown
}

interface CursorHooksJson {
  version?: number
  hooks?: Record<string, CursorHookEntry[]>
  [key: string]: unknown
}

// preToolUse/postToolUse only re-assert 'working' for a pane whose state the
// listener lost (app restart mid-turn) — see CursorNotifyListener.ingest.
const MANAGED_EVENT_NAMES = ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop'] as const

const HOOK_TIMEOUT_SECONDS = 5

export function getCursorGlobalHooksPath(home: string = os.homedir()): string {
  return path.join(home, '.cursor', 'hooks.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHooksJson(hooksPath: string): CursorHooksJson | null {
  if (!fs.existsSync(hooksPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'))
    return isPlainObject(parsed) ? (parsed as CursorHooksJson) : null
  } catch (error) {
    console.warn('[cursor-hooks-setup] Failed to parse', hooksPath, error)
    return null
  }
}

/** Entries THIS install wrote — path-scoped so dev and prod builds don't strip
 *  each other's hooks (see the note on claude-hooks-setup's twin). */
function isManagedCommand(command: string | undefined, notifyPath: string): boolean {
  if (!command) return false
  if (command === notifyPath) return true
  return command.endsWith(notifyPath) || command.includes(`${notifyPath} `)
}

/**
 * Returns the merged hooks.json content with orchestra's managed entries, or
 * `null` when the existing file is unparseable (we refuse to clobber user data).
 */
export function buildCursorHooksJsonContent(
  existing: CursorHooksJson | null,
  notifyPath: string,
): string | null {
  if (existing === null) return null
  const next: CursorHooksJson = { ...existing }
  if (typeof next.version !== 'number') next.version = 1
  const hooksField = isPlainObject(next.hooks) ? { ...next.hooks } : {}

  for (const eventName of Object.keys(hooksField)) {
    const current = hooksField[eventName]
    if (!Array.isArray(current)) continue
    const filtered = current.filter((entry) => !isManagedCommand(entry?.command, notifyPath))
    if (filtered.length === 0) {
      delete hooksField[eventName]
    } else {
      hooksField[eventName] = filtered
    }
  }

  for (const eventName of MANAGED_EVENT_NAMES) {
    const managed: CursorHookEntry = { command: notifyPath, timeout: HOOK_TIMEOUT_SECONDS }
    const current = hooksField[eventName]
    hooksField[eventName] = Array.isArray(current) ? [...current, managed] : [managed]
  }

  next.hooks = hooksField
  return JSON.stringify(next, null, 2) + '\n'
}

export interface EnsureCursorHooksResult {
  notifyPath: string
  hooksPath: string
  hooksChanged: boolean
  scriptChanged: boolean
}

/** Writes the notify script, then merges hook entries into ~/.cursor/hooks.json. */
export function ensureCursorHooksRegistered(opts: {
  home?: string
  env?: NodeJS.ProcessEnv
} = {}): EnsureCursorHooksResult | null {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const { path: notifyPath, changed: scriptChanged } = ensureCursorNotifyScript(env)

  const hooksPath = getCursorGlobalHooksPath(home)
  const existing = readHooksJson(hooksPath)
  const content = buildCursorHooksJsonContent(existing, notifyPath)
  if (content === null) {
    console.warn('[cursor-hooks-setup] refusing to overwrite unparseable', hooksPath)
    return null
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true })
  const previous = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : null
  if (previous === content) {
    return { notifyPath, hooksPath, hooksChanged: false, scriptChanged }
  }

  fs.writeFileSync(hooksPath, content, { mode: 0o644 })
  return { notifyPath, hooksPath, hooksChanged: true, scriptChanged }
}
