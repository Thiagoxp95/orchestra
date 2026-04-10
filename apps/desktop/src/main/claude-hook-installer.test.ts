import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  detectClaudeHookInstallState,
  mergeClaudeHooksIntoSettings,
  installClaudeHooks,
  buildClaudeHookCommand,
  parseSelfTestResult,
} from './claude-hook-installer'
import { CLAUDE_HOOK_VERSION, ensureClaudeHookRuntimeInstalled, getClaudeHookRuntimePaths } from './claude-hook-runtime'

describe('claude-hook-installer', () => {
  let tmpHome: string
  let claudeDir: string
  let settingsPath: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-install-'))
    claudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    settingsPath = path.join(claudeDir, 'settings.json')
  })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  function env() {
    return { HOME: tmpHome }
  }

  describe('detectClaudeHookInstallState', () => {
    it('returns not-installed when script is missing', () => {
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns not-installed when script exists but settings.json does not', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns error when settings.json has a syntax error', () => {
      ensureClaudeHookRuntimeInstalled(env())
      fs.writeFileSync(settingsPath, '{ "hooks": }')
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('error')
      if (state.status === 'error') {
        expect(state.reason).toBe('settings-malformed')
      }
    })

    it('returns installed when all entries + script exist', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'UserPromptSubmit') }] }],
          PreToolUse:       [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PreToolUse') }] }],
          PostToolUse:      [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PostToolUse') }] }],
          PermissionRequest:[{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PermissionRequest') }] }],
          Notification:     [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Notification') }] }],
          Stop:             [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Stop') }] }],
        }
      }, null, 2))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed')
      if (state.status === 'installed') {
        expect(state.version).toBe(CLAUDE_HOOK_VERSION)
      }
    })

    it('returns not-installed when any one of the 6 events is missing', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'UserPromptSubmit') }] }],
          PreToolUse:       [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PreToolUse') }] }],
          PostToolUse:      [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PostToolUse') }] }],
          PermissionRequest:[{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PermissionRequest') }] }],
          Stop:             [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Stop') }] }],
        }
      }))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns installed-stale when script version differs', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(paths.notifyScriptPath, '#!/bin/bash\n# version=0\nexit 0\n', { mode: 0o755 })
      const events = ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop'] as const
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: Object.fromEntries(
          events.map((ev) => [
            ev, [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, ev) }] }],
          ])
        ),
      }))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed-stale')
      if (state.status === 'installed-stale') {
        expect(state.installedVersion).toBe('0')
        expect(state.currentVersion).toBe(CLAUDE_HOOK_VERSION)
      }
    })
  })

  describe('mergeClaudeHooksIntoSettings', () => {
    it('creates the hooks section and all 6 entries when empty', () => {
      const result = mergeClaudeHooksIntoSettings({}, '/tmp/claude-notify.sh')
      expect(Object.keys(result.hooks)).toEqual(
        expect.arrayContaining(['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop'])
      )
      for (const ev of ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop']) {
        const entries = result.hooks[ev]
        expect(Array.isArray(entries)).toBe(true)
        const has = entries.some((e: any) => e.hooks?.some((h: any) => String(h.command).includes('claude-notify.sh')))
        expect(has).toBe(true)
      }
    })

    it('is idempotent — re-merging adds nothing new', () => {
      const first = mergeClaudeHooksIntoSettings({}, '/tmp/claude-notify.sh')
      const second = mergeClaudeHooksIntoSettings(first, '/tmp/claude-notify.sh')
      expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
    })

    it('preserves unrelated sibling keys and unrelated hook entries', () => {
      const existing = {
        permissions: { allow: ['a', 'b'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python ~/.claude/ccnotify/ccnotify.py UserPromptSubmit' }] }],
        },
      }
      const result = mergeClaudeHooksIntoSettings(existing, '/tmp/claude-notify.sh')
      expect(result.permissions).toEqual({ allow: ['a', 'b'] })
      // CCNotify entry is preserved
      const ups = result.hooks.UserPromptSubmit
      expect(ups.length).toBe(2)
      expect(ups[0].hooks[0].command).toContain('ccnotify.py')
      expect(ups[1].hooks[0].command).toContain('claude-notify.sh')
    })
  })

  describe('installClaudeHooks', () => {
    it('writes the script + settings.json with all 6 entries', async () => {
      const result = await installClaudeHooks({ env: env(), selfTest: async () => ({ ok: true }) })
      expect(result.ok).toBe(true)

      const paths = getClaudeHookRuntimePaths(env())
      expect(fs.existsSync(paths.notifyScriptPath)).toBe(true)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      for (const ev of ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop']) {
        expect(settings.hooks[ev]).toBeDefined()
      }

      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed')
    })

    it('refuses to install when settings.json is malformed', async () => {
      fs.writeFileSync(settingsPath, '{ broken')
      const result = await installClaudeHooks({ env: env(), selfTest: async () => ({ ok: true }) })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('settings-malformed')
    })

    it('rolls back to the pre-write settings when self-test fails', async () => {
      const preWrite = JSON.stringify({ permissions: { allow: ['x'] } }, null, 2)
      fs.writeFileSync(settingsPath, preWrite)
      const result = await installClaudeHooks({
        env: env(),
        selfTest: async () => ({ ok: false, detail: 'Invalid settings — key permissions.allow.0' }),
      })
      expect(result.ok).toBe(false)
      const after = fs.readFileSync(settingsPath, 'utf8')
      expect(after).toBe(preWrite)
    })

    it('removes the newly-written settings file when self-test fails and there was no pre-existing settings', async () => {
      // No settings.json on disk before install
      expect(fs.existsSync(settingsPath)).toBe(false)

      const result = await installClaudeHooks({
        env: env(),
        selfTest: async () => ({ ok: false, detail: 'Invalid settings' }),
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('claude-rejected-settings')
      // Rollback should have unlinked the file we just created
      expect(fs.existsSync(settingsPath)).toBe(false)
    })
  })

  describe('parseSelfTestResult', () => {
    it('returns ok for empty stderr', () => {
      expect(parseSelfTestResult('')).toEqual({ ok: true })
    })

    it('returns ok for innocuous stderr containing "key:"', () => {
      expect(parseSelfTestResult('checking key: permissions')).toEqual({ ok: true })
      expect(parseSelfTestResult('ssh-key: generated\n')).toEqual({ ok: true })
    })

    it('returns failure when stderr contains "Invalid settings"', () => {
      const result = parseSelfTestResult('error: Invalid settings in userSettings\n')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.detail).toContain('Invalid settings')
      }
    })

    it('truncates long stderr to the last 1024 chars in detail', () => {
      const long = 'a'.repeat(2000) + 'Invalid settings'
      const result = parseSelfTestResult(long)
      if (!result.ok) {
        expect(result.detail.length).toBe(1024)
        expect(result.detail).toContain('Invalid settings')
      }
    })
  })

  describe('entryRefersToOurScript via mergeClaudeHooksIntoSettings (full-path matching)', () => {
    it('does NOT treat a different tool as Orchestra just because the basename matches', () => {
      const orchestraPath = '/users/alice/.orchestra/hooks/claude-notify.sh'
      const otherToolPath = '/some/other/place/claude-notify.sh'
      const existing = {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `bash ${otherToolPath} UserPromptSubmit` }] }],
        },
      }
      const result = mergeClaudeHooksIntoSettings(existing, orchestraPath)
      // Both entries should now exist — the other tool's entry is preserved, AND Orchestra adds its own
      expect(result.hooks.UserPromptSubmit.length).toBe(2)
      const commands = result.hooks.UserPromptSubmit.map((e: any) => e.hooks[0].command)
      expect(commands.some((c: string) => c.includes(otherToolPath))).toBe(true)
      expect(commands.some((c: string) => c.includes(orchestraPath))).toBe(true)
    })

    it('treats an existing Orchestra entry as already wired (idempotent on the full path)', () => {
      const orchestraPath = '/users/alice/.orchestra/hooks/claude-notify.sh'
      const existing = {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `bash ${orchestraPath} UserPromptSubmit` }] }],
        },
      }
      const result = mergeClaudeHooksIntoSettings(existing, orchestraPath)
      // Only one entry — no duplicate from re-merging
      expect(result.hooks.UserPromptSubmit.length).toBe(1)
    })
  })
})
