// Merges orchestra's managed entries into ~/.claude/settings.json so Claude
// fires our notify script on each lifecycle event without per-launch wrapping.
// This replaces the OSC-title spinner-glyph heuristic (claude-work-indicator)
// with explicit agent-reported state; the title scraper stays as a fallback.
//
// settings.json is the user's *primary* Claude config (permissions, statusLine,
// env, ...), NOT a dedicated hooks file — so we spread every existing key
// through untouched and only ever add/replace our own managed hook entries.
// User hooks and unrelated events are preserved; re-runs are idempotent; we
// refuse to write when the existing file is unparseable.
//
// Mirrors codex-hooks-setup.ts. The two differences from codex's hooks.json:
// (1) tool-scoped events carry a `matcher: '*'`, and (2) the config lives under
// `.claude/settings.json` rather than a standalone hooks file.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLAUDE_NOTIFY_SCRIPT_NAME, ensureClaudeNotifyScript } from './claude-notify-script'

interface ClaudeHookCommand {
  type?: string
  command?: string
  [key: string]: unknown
}

interface ClaudeHookDefinition {
  matcher?: string
  hooks?: ClaudeHookCommand[]
  [key: string]: unknown
}

interface ClaudeSettingsJson {
  hooks?: Record<string, ClaudeHookDefinition[]>
  [key: string]: unknown
}

// Events orchestra registers. `matcher: '*'` marks tool-scoped events (Claude
// requires the matcher there); the rest are turn/lifecycle events with no
// matcher. Older Claude builds ignore event names they don't recognize, so
// registering the fuller set (StopFailure, PermissionRequest, SubagentStart,
// TeammateIdle) is safe even where a given build never fires them.
const MANAGED_EVENTS: readonly { eventName: string; matcher?: string }[] = [
  // No matcher: fires for every source (startup | resume | clear | compact),
  // each of which changes which transcript the session is writing.
  { eventName: 'SessionStart' },
  { eventName: 'UserPromptSubmit' },
  { eventName: 'Stop' },
  { eventName: 'StopFailure' },
  { eventName: 'SubagentStart' },
  { eventName: 'SubagentStop' },
  { eventName: 'TeammateIdle' },
  { eventName: 'PreToolUse', matcher: '*' },
  { eventName: 'PostToolUse', matcher: '*' },
  { eventName: 'PostToolUseFailure', matcher: '*' },
  { eventName: 'PermissionRequest', matcher: '*' },
]

export function getClaudeSettingsPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSettingsJson(settingsPath: string): ClaudeSettingsJson | null {
  if (!fs.existsSync(settingsPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return isPlainObject(parsed) ? (parsed as ClaudeSettingsJson) : null
  } catch (error) {
    console.warn('[claude-hooks-setup] Failed to parse', settingsPath, error)
    return null
  }
}

function isManagedCommand(command: string | undefined, notifyPath: string): boolean {
  if (!command) return false
  // Exact match for our notify path, or a path ending in our well-known script
  // name (covers dev/prod switches under different ORCHESTRA_HOME).
  if (command === notifyPath) return true
  return command.endsWith(`/${CLAUDE_NOTIFY_SCRIPT_NAME}`)
}

function stripManagedFromDefinition(
  definition: ClaudeHookDefinition,
  notifyPath: string,
): ClaudeHookDefinition | null {
  if (!Array.isArray(definition.hooks)) return definition
  const filtered = definition.hooks.filter((hook) => !isManagedCommand(hook.command, notifyPath))
  if (filtered.length === definition.hooks.length) return definition
  if (filtered.length === 0) return null
  return { ...definition, hooks: filtered }
}

function buildManagedDefinition(notifyPath: string, matcher?: string): ClaudeHookDefinition {
  const definition: ClaudeHookDefinition = {
    hooks: [{ type: 'command', command: notifyPath }],
  }
  if (matcher !== undefined) definition.matcher = matcher
  return definition
}

/**
 * Returns the merged settings.json content with orchestra's managed hook
 * entries, or `null` when the existing file is unparseable (we refuse to
 * clobber user data). Every non-hook top-level key is preserved verbatim.
 */
export function buildClaudeSettingsJsonContent(
  existing: ClaudeSettingsJson | null,
  notifyPath: string,
): string | null {
  if (existing === null) return null
  const next: ClaudeSettingsJson = { ...existing }
  const hooksField = isPlainObject(next.hooks) ? { ...next.hooks } : {}

  // First, strip ANY stale orchestra-managed entries across all events (covers
  // events we previously registered but no longer manage).
  for (const eventName of Object.keys(hooksField)) {
    const current = hooksField[eventName]
    if (!Array.isArray(current)) continue
    const filtered = current
      .map((def) => stripManagedFromDefinition(def, notifyPath))
      .filter((def): def is ClaudeHookDefinition => def !== null)
    if (filtered.length === 0) {
      delete hooksField[eventName]
    } else {
      hooksField[eventName] = filtered
    }
  }

  // Then, append a fresh managed entry for each event we currently manage.
  for (const { eventName, matcher } of MANAGED_EVENTS) {
    const managed = buildManagedDefinition(notifyPath, matcher)
    const current = hooksField[eventName]
    hooksField[eventName] = Array.isArray(current) ? [...current, managed] : [managed]
  }

  next.hooks = hooksField
  return JSON.stringify(next, null, 2) + '\n'
}

export interface EnsureClaudeHooksResult {
  notifyPath: string
  settingsPath: string
  hooksChanged: boolean
  scriptChanged: boolean
}

/** Writes the notify script, then merges hook entries into ~/.claude/settings.json. */
export function ensureClaudeHooksRegistered(opts: {
  home?: string
  env?: NodeJS.ProcessEnv
} = {}): EnsureClaudeHooksResult | null {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const { path: notifyPath, changed: scriptChanged } = ensureClaudeNotifyScript(env)

  const settingsPath = getClaudeSettingsPath(home)
  const existing = readSettingsJson(settingsPath)
  const content = buildClaudeSettingsJsonContent(existing, notifyPath)
  if (content === null) {
    console.warn('[claude-hooks-setup] refusing to overwrite unparseable', settingsPath)
    return null
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const previous = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
  if (previous === content) {
    return { notifyPath, settingsPath, hooksChanged: false, scriptChanged }
  }

  fs.writeFileSync(settingsPath, content, { mode: 0o644 })
  return { notifyPath, settingsPath, hooksChanged: true, scriptChanged }
}
