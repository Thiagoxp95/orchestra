import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CLAUDE_HOOK_VERSION,
  buildClaudeNotifyScript,
  getClaudeHookRuntimePaths,
  ensureClaudeHookRuntimeInstalled,
  readInstalledScriptVersion,
} from './claude-hook-runtime'

describe('claude-hook-runtime', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-rt-'))
  })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('bakes the current version into the script', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
  })

  it('early-exits when ORCHESTRA_SESSION_ID is absent', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain('[ -z "$ORCHESTRA_SESSION_ID" ] && exit 0')
    expect(script).toContain('[ -z "$ORCHESTRA_HOOK_PORT" ] && exit 0')
  })

  it('recognizes the 6 wired event names', () => {
    const script = buildClaudeNotifyScript()
    for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop']) {
      expect(script).toContain(ev)
    }
  })

  it('posts to /claude/hook on the hook server', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain('curl -sG "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/claude/hook"')
  })

  it('always exit 0 to avoid breaking Claude turns', () => {
    const script = buildClaudeNotifyScript()
    expect(script.trimEnd().endsWith('exit 0')).toBe(true)
  })

  it('derives paths under the Orchestra hooks dir', () => {
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    expect(paths.notifyScriptPath).toBe(
      path.join(tmpHome, '.orchestra', 'hooks', 'claude-notify.sh')
    )
  })

  it('ensureClaudeHookRuntimeInstalled writes the script and sets 0755', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    const stat = fs.statSync(paths.notifyScriptPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(paths.notifyScriptPath, 'utf8')).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
  })

  it('ensure is idempotent and overwrites stale content on version mismatch', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    fs.writeFileSync(paths.notifyScriptPath, '#!/bin/bash\n# version=old\nexit 0\n', { mode: 0o755 })
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const content = fs.readFileSync(paths.notifyScriptPath, 'utf8')
    expect(content).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
    expect(content).not.toContain('# version=old')
  })

  it('readInstalledScriptVersion returns null when the script is missing', () => {
    expect(readInstalledScriptVersion({ HOME: tmpHome })).toBe(null)
  })

  it('readInstalledScriptVersion parses the version marker from an installed script', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    expect(readInstalledScriptVersion({ HOME: tmpHome })).toBe(CLAUDE_HOOK_VERSION)
  })

  it('readInstalledScriptVersion returns null for an installed script with no version marker', () => {
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    fs.mkdirSync(paths.hooksDir, { recursive: true })
    fs.writeFileSync(paths.notifyScriptPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    expect(readInstalledScriptVersion({ HOME: tmpHome })).toBe(null)
  })

  it('ensureClaudeHookRuntimeInstalled is a no-op when content is already current', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    const firstStat = fs.statSync(paths.notifyScriptPath)

    // Re-run; the file should remain at 0755 and content unchanged
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const secondStat = fs.statSync(paths.notifyScriptPath)

    expect(secondStat.mode & 0o777).toBe(0o755)
    expect(secondStat.size).toBe(firstStat.size)
    // Content should still match the current generator output
    expect(fs.readFileSync(paths.notifyScriptPath, 'utf8')).toBe(firstStat.size > 0 ? buildClaudeNotifyScript() : '')
  })
})
