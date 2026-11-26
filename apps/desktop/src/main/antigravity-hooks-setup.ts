// Merges orchestra's managed hook group into ~/.gemini/config/hooks.json so
// the Google Antigravity CLI (`agy`) fires our notify script without per-launch
// wrapping. Mirrors cursor-hooks-setup.ts; Antigravity's hooks.json maps each
// top-level hook name to its event config (flat handler arrays for SessionStart,
// PreInvocation, Stop; grouped `{matcher, hooks}` arrays for PreToolUse and
// PostToolUse).
//
// Other named hooks are preserved untouched; dev and prod installs use distinct
// top-level keys so they never strip each other; re-runs are idempotent; an
// unparseable file is never overwritten.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureAntigravityNotifyScript } from './antigravity-notify-script'
import { isOrchestraDevEnv } from './orchestra-paths'

interface AntigravityHookHandler {
  type?: string
  command?: string
  timeout?: number
  [key: string]: unknown
}

interface AntigravityToolHookGroup {
  matcher?: string
  hooks?: AntigravityHookHandler[]
  [key: string]: unknown
}

interface AntigravityNamedHook {
  enabled?: boolean
  SessionStart?: AntigravityHookHandler[]
  PreInvocation?: AntigravityHookHandler[]
  PreToolUse?: AntigravityToolHookGroup[]
  PostToolUse?: AntigravityToolHookGroup[]
  Stop?: AntigravityHookHandler[]
  [key: string]: unknown
}

type AntigravityHooksJson = Record<string, AntigravityNamedHook>

const HOOK_TIMEOUT_SECONDS = 5

export function getAntigravityGlobalHooksPath(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'config', 'hooks.json')
}

export function getAntigravityManagedHookName(env: NodeJS.ProcessEnv = process.env): string {
  return isOrchestraDevEnv(env) ? 'orchestra-dev-notify' : 'orchestra-notify'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHooksJson(hooksPath: string): AntigravityHooksJson | null {
  if (!fs.existsSync(hooksPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'))
    return isPlainObject(parsed) ? (parsed as AntigravityHooksJson) : null
  } catch (error) {
    console.warn('[antigravity-hooks-setup] Failed to parse', hooksPath, error)
    return null
  }
}

/**
 * Returns the merged hooks.json content with orchestra's managed named hook, or
 * `null` when the existing file is unparseable (we refuse to clobber user data).
 */
export function buildAntigravityHooksJsonContent(
  existing: AntigravityHooksJson | null,
  notifyPath: string,
  hookName: string = 'orchestra-notify',
): string | null {
  if (existing === null) return null
  const next: AntigravityHooksJson = { ...existing }
  const handler: AntigravityHookHandler = {
    type: 'command',
    command: notifyPath,
    timeout: HOOK_TIMEOUT_SECONDS,
  }

  // PreToolUse is scoped to ask_question so we immediately surface
  // waitingUserInput without firing a shell hook on every normal tool call or
  // interfering with permission decisions for other tools.
  next[hookName] = {
    SessionStart: [handler],
    PreInvocation: [handler],
    PreToolUse: [
      {
        matcher: 'ask_question',
        hooks: [handler],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [handler],
      },
    ],
    Stop: [handler],
  }

  return JSON.stringify(next, null, 2) + '\n'
}

export interface EnsureAntigravityHooksResult {
  notifyPath: string
  hooksPath: string
  hooksChanged: boolean
  scriptChanged: boolean
}

/** Writes the notify script, then merges hook entries into ~/.gemini/config/hooks.json. */
export function ensureAntigravityHooksRegistered(opts: {
  home?: string
  env?: NodeJS.ProcessEnv
} = {}): EnsureAntigravityHooksResult | null {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const { path: notifyPath, changed: scriptChanged } = ensureAntigravityNotifyScript(env)

  const hooksPath = getAntigravityGlobalHooksPath(home)
  const existing = readHooksJson(hooksPath)
  const hookName = getAntigravityManagedHookName(env)
  const content = buildAntigravityHooksJsonContent(existing, notifyPath, hookName)
  if (content === null) {
    console.warn('[antigravity-hooks-setup] refusing to overwrite unparseable', hooksPath)
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
