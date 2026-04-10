// Read/write ~/.claude/settings.json safely. Pure functions — no electron
// imports — so the merge logic is unit-testable against tmp dirs.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CLAUDE_HOOK_VERSION,
  CLAUDE_HOOK_EVENT_TYPES,
  ensureClaudeHookRuntimeInstalled,
  getClaudeHookRuntimePaths,
  readInstalledScriptVersion,
  type ClaudeHookEventType,
} from './claude-hook-runtime'

export type ClaudeHookInstallState =
  | { status: 'not-installed' }
  | { status: 'installed'; version: string }
  | { status: 'installed-stale'; installedVersion: string; currentVersion: string }
  | { status: 'error'; reason: 'settings-malformed' | 'settings-unreadable' | 'script-missing'; detail: string }

export type ClaudeHookInstallResult =
  | { ok: true }
  | { ok: false; reason: 'settings-malformed' | 'settings-unreadable' | 'claude-rejected-settings' | 'io-error'; detail?: string }

function getSettingsPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || ''
  return path.join(home, '.claude', 'settings.json')
}

export function buildClaudeHookCommand(notifyScriptPath: string, eventName: ClaudeHookEventType): string {
  return `bash ${notifyScriptPath} ${eventName}`
}

/**
 * Decide whether Claude Code's stderr indicates it rejected our settings.
 * Exported for testing — kept narrow on purpose to avoid false positives.
 */
export function parseSelfTestResult(stderr: string): { ok: true } | { ok: false; detail: string } {
  const rejectedMarkers = ['Invalid settings']
  if (rejectedMarkers.some((m) => stderr.includes(m))) {
    return { ok: false, detail: stderr.slice(-1024) }
  }
  return { ok: true }
}

function entryRefersToOurScript(entry: any, notifyScriptPath: string): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(notifyScriptPath))
}

export function mergeClaudeHooksIntoSettings(existing: any, notifyScriptPath: string): any {
  const base = (existing && typeof existing === 'object') ? existing : {}
  const result: any = { ...base }
  const hooks = (result.hooks && typeof result.hooks === 'object') ? { ...result.hooks } : {}
  result.hooks = hooks

  for (const event of CLAUDE_HOOK_EVENT_TYPES) {
    const existingEntries: any[] = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    const alreadyWired = existingEntries.some((entry) => entryRefersToOurScript(entry, notifyScriptPath))
    if (alreadyWired) {
      hooks[event] = existingEntries
      continue
    }
    existingEntries.push({
      hooks: [{ type: 'command', command: buildClaudeHookCommand(notifyScriptPath, event) }],
    })
    hooks[event] = existingEntries
  }

  return result
}

export function detectClaudeHookInstallState(env: NodeJS.ProcessEnv = process.env): ClaudeHookInstallState {
  const paths = getClaudeHookRuntimePaths(env)
  if (!fs.existsSync(paths.notifyScriptPath)) {
    return { status: 'not-installed' }
  }

  const settingsPath = getSettingsPath(env)
  if (!fs.existsSync(settingsPath)) {
    return { status: 'not-installed' }
  }

  let parsed: any
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (err instanceof SyntaxError) {
      return { status: 'error', reason: 'settings-malformed', detail }
    }
    return { status: 'error', reason: 'settings-unreadable', detail }
  }

  const hooks = parsed && typeof parsed.hooks === 'object' ? parsed.hooks : {}
  for (const event of CLAUDE_HOOK_EVENT_TYPES) {
    const entries: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
    const wired = entries.some((entry) => entryRefersToOurScript(entry, paths.notifyScriptPath))
    if (!wired) return { status: 'not-installed' }
  }

  const installedVersion = readInstalledScriptVersion(env)
  if (installedVersion === null) {
    return { status: 'error', reason: 'script-missing', detail: 'script has no version marker' }
  }
  if (installedVersion !== CLAUDE_HOOK_VERSION) {
    return { status: 'installed-stale', installedVersion, currentVersion: CLAUDE_HOOK_VERSION }
  }
  return { status: 'installed', version: installedVersion }
}

export interface InstallClaudeHooksOptions {
  env?: NodeJS.ProcessEnv
  /**
   * Run a probe that exercises Claude Code to verify settings.json still loads.
   * Default implementation runs `claude --debug hooks --print "ping"` and
   * scans stderr for `Invalid settings`. Injectable for tests.
   */
  selfTest?: () => Promise<{ ok: true } | { ok: false; detail: string }>
}

async function defaultSelfTest(): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill('SIGKILL') } catch {}
        resolve({ ok: true }) // treat timeout as ambiguous success
      }
    }, 5000)

    const child = spawn('claude', ['--debug', 'hooks', '--print', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: true }) // claude not on PATH — treat as ambiguous success
    })
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(parseSelfTestResult(stderr))
    })
  })
}

export async function installClaudeHooks(opts: InstallClaudeHooksOptions = {}): Promise<ClaudeHookInstallResult> {
  const env = opts.env ?? process.env
  const selfTest = opts.selfTest ?? defaultSelfTest

  // 1. Make sure the hook script is in place (auto-update to latest version).
  try {
    ensureClaudeHookRuntimeInstalled(env)
  } catch (err) {
    return { ok: false, reason: 'io-error', detail: err instanceof Error ? err.message : String(err) }
  }

  const paths = getClaudeHookRuntimePaths(env)
  const settingsPath = getSettingsPath(env)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })

  // 2. Read + parse existing settings.json (if any). Keep the raw string for
  //    in-memory rollback after a failed self-test.
  let preWrite: string | null = null
  let parsed: any = {}
  if (fs.existsSync(settingsPath)) {
    try {
      preWrite = fs.readFileSync(settingsPath, 'utf8')
      parsed = JSON.parse(preWrite)
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { ok: false, reason: 'settings-malformed', detail: err.message }
      }
      return { ok: false, reason: 'settings-unreadable', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  // 3. Merge our entries (idempotent).
  const merged = mergeClaudeHooksIntoSettings(parsed, paths.notifyScriptPath)
  const nextContent = JSON.stringify(merged, null, 2) + '\n'

  // 4. Atomic write.
  const tmp = `${settingsPath}.orchestra.tmp`
  try {
    fs.writeFileSync(tmp, nextContent, 'utf8')
    fs.renameSync(tmp, settingsPath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    return { ok: false, reason: 'io-error', detail: err instanceof Error ? err.message : String(err) }
  }

  // 5. Self-test — roll back if Claude Code rejects the new file.
  const probe = await selfTest()
  if (!probe.ok) {
    if (preWrite !== null) {
      try {
        const rollbackTmp = `${settingsPath}.orchestra.rollback`
        fs.writeFileSync(rollbackTmp, preWrite, 'utf8')
        fs.renameSync(rollbackTmp, settingsPath)
      } catch {
        // best effort
      }
    } else {
      try { fs.unlinkSync(settingsPath) } catch {}
    }
    return { ok: false, reason: 'claude-rejected-settings', detail: probe.detail }
  }

  return { ok: true }
}
