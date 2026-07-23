import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildClaudeSettingsJsonContent,
  ensureClaudeHooksRegistered,
  getClaudeSettingsPath,
} from './claude-hooks-setup'
import { CLAUDE_NOTIFY_SCRIPT_NAME } from './claude-notify-script'

const NOTIFY = '/tmp/orch-test-claude-notify.sh'

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']
const LIFECYCLE_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle']

function managedCommands(parsed: any, eventName: string): string[] {
  return ((parsed.hooks[eventName] as any[]) ?? [])
    .flatMap((def: any) => (def.hooks ?? []).map((h: any) => h.command))
}

describe('buildClaudeSettingsJsonContent', () => {
  it('returns null when the existing file was unparseable', () => {
    expect(buildClaudeSettingsJsonContent(null, NOTIFY)).toBeNull()
  })

  it('registers every managed event in an empty file', () => {
    const parsed = JSON.parse(buildClaudeSettingsJsonContent({}, NOTIFY)!)
    for (const eventName of [...TOOL_EVENTS, ...LIFECYCLE_EVENTS]) {
      expect(managedCommands(parsed, eventName)).toContain(NOTIFY)
    }
  })

  it('adds matcher:"*" to tool-scoped events but not lifecycle events', () => {
    const parsed = JSON.parse(buildClaudeSettingsJsonContent({}, NOTIFY)!)
    for (const eventName of TOOL_EVENTS) {
      expect(parsed.hooks[eventName][0].matcher).toBe('*')
    }
    for (const eventName of LIFECYCLE_EVENTS) {
      expect(parsed.hooks[eventName][0].matcher).toBeUndefined()
    }
  })

  it('preserves non-hook top-level settings keys verbatim', () => {
    const existing = {
      statusLine: { type: 'command', command: '/custom/statusline.sh' },
      permissions: { allow: ['Bash(ls:*)'] },
      env: { FOO: 'bar' },
    }
    const parsed = JSON.parse(buildClaudeSettingsJsonContent(existing, NOTIFY)!)
    expect(parsed.statusLine).toEqual(existing.statusLine)
    expect(parsed.permissions).toEqual(existing.permissions)
    expect(parsed.env).toEqual(existing.env)
  })

  it('preserves user-defined hooks alongside our managed entry', () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/custom/user-hook.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/custom/pre.sh' }] }],
      },
    }
    const parsed = JSON.parse(buildClaudeSettingsJsonContent(existing, NOTIFY)!)
    expect(managedCommands(parsed, 'UserPromptSubmit')).toContain('/custom/user-hook.sh')
    expect(managedCommands(parsed, 'UserPromptSubmit')).toContain(NOTIFY)
    expect(managedCommands(parsed, 'PreToolUse')).toContain('/custom/pre.sh')
    expect(managedCommands(parsed, 'PreToolUse')).toContain(NOTIFY)
    // The user's own PreToolUse matcher survives untouched.
    expect((parsed.hooks.PreToolUse as any[]).some((d) => d.matcher === 'Bash')).toBe(true)
  })

  it('is idempotent — re-running produces identical content with no duplicate managed entries', () => {
    const once = buildClaudeSettingsJsonContent({}, NOTIFY)!
    const twice = buildClaudeSettingsJsonContent(JSON.parse(once), NOTIFY)!
    expect(twice).toBe(once)
    const parsed = JSON.parse(twice)
    // Exactly one managed command per event, no stacking across runs.
    for (const eventName of [...TOOL_EVENTS, ...LIFECYCLE_EVENTS]) {
      expect(managedCommands(parsed, eventName).filter((c) => c === NOTIFY)).toHaveLength(1)
    }
  })

  it('strips a stale managed entry identified by script basename under a different path', () => {
    const stale = `/old/orchestra/hooks/${CLAUDE_NOTIFY_SCRIPT_NAME}`
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: stale }] }] } }
    const parsed = JSON.parse(buildClaudeSettingsJsonContent(existing, NOTIFY)!)
    const cmds = managedCommands(parsed, 'Stop')
    expect(cmds).not.toContain(stale)
    expect(cmds).toContain(NOTIFY)
    expect(cmds).toHaveLength(1)
  })
})

describe('ensureClaudeHooksRegistered', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-'))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('writes the settings file and notify script, and is idempotent on the second run', () => {
    const env = { ...process.env, HOME: home, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const first = ensureClaudeHooksRegistered({ home, env })
    expect(first).not.toBeNull()
    expect(first!.hooksChanged).toBe(true)
    expect(fs.existsSync(getClaudeSettingsPath(home))).toBe(true)
    expect(fs.existsSync(first!.notifyPath)).toBe(true)

    const second = ensureClaudeHooksRegistered({ home, env })
    expect(second!.hooksChanged).toBe(false)
  })

  it('refuses to overwrite an unparseable settings file', () => {
    const env = { ...process.env, HOME: home, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const settingsPath = getClaudeSettingsPath(home)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ this is not json')
    expect(ensureClaudeHooksRegistered({ home, env })).toBeNull()
    // Left the user's file untouched.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ this is not json')
  })
})
