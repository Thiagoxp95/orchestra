import { describe, expect, it } from 'vitest'
import {
  buildClaudeNotifyScript,
  buildClaudeSettingsContent,
  buildClaudeWrapperScript,
} from './claude-hook-runtime'

describe('buildClaudeSettingsContent', () => {
  it('registers the expected Claude hook events', () => {
    const content = JSON.parse(buildClaudeSettingsContent('/tmp/orchestra-notify.sh'))

    expect(content).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/tmp/orchestra-notify.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/tmp/orchestra-notify.sh' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/tmp/orchestra-notify.sh' }] }],
        PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: '/tmp/orchestra-notify.sh' }] }],
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/tmp/orchestra-notify.sh' }] }],
      },
    })
  })
})

describe('buildClaudeNotifyScript', () => {
  it('normalizes Claude hook events into Orchestra lifecycle events', () => {
    const script = buildClaudeNotifyScript()

    expect(script).toContain('HOOK_PORT="${ORCHESTRA_HOOK_PORT:-}"')
    expect(script).toContain('UserPromptSubmit|PostToolUse|PostToolUseFailure')
    expect(script).toContain('EVENT_TYPE="Start"')
    expect(script).toContain('PermissionRequest')
    expect(script).toContain(`/claude/hook`)
    expect(script).not.toContain('48135')
  })
})

describe('buildClaudeWrapperScript', () => {
  it('forces Claude to use the Orchestra settings file', () => {
    const script = buildClaudeWrapperScript('/Users/txp/.orchestra/bin', '/Users/txp/.orchestra/hooks/claude-settings.json')

    expect(script).toContain('find_real_binary')
    expect(script).toContain('exec "$REAL_BIN" --settings')
    expect(script).toContain('/Users/txp/.orchestra/hooks/claude-settings.json')
    expect(script).toContain('/Users/txp/.orchestra/bin')
  })
})
