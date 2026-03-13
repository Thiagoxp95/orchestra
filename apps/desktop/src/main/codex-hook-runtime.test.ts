import { describe, expect, it } from 'vitest'
import {
  buildCodexNotifyScript,
  buildCodexWrapperScript,
  getCodexSessionLogPath,
} from './codex-hook-runtime'

describe('getCodexSessionLogPath', () => {
  it('derives a deterministic per-session log path inside the Orchestra hooks directory', () => {
    expect(getCodexSessionLogPath('session-123', {
      HOME: '/Users/txp',
      ELECTRON_IS_DEV: '0',
    })).toBe('/Users/txp/.orchestra/hooks/codex-sessions/session-123.jsonl')
  })
})

describe('buildCodexNotifyScript', () => {
  it('normalizes Orchestra Codex wrapper events into hook requests', () => {
    const script = buildCodexNotifyScript()

    expect(script).toContain('HOOK_PORT="${ORCHESTRA_HOOK_PORT:-}"')
    expect(script).toContain('Start|Stop|PermissionRequest|UserInputRequest')
    expect(script).toContain('/codex/hook')
  })
})

describe('buildCodexWrapperScript', () => {
  it('records a deterministic session log and forwards lifecycle events', () => {
    const script = buildCodexWrapperScript(
      '/Users/txp/.orchestra/bin',
      '/Users/txp/.orchestra/hooks/codex-notify.sh',
      '/Users/txp/.orchestra/hooks/codex-sessions',
    )

    expect(script).toContain('find_real_binary')
    expect(script).toContain('CODEX_TUI_RECORD_SESSION=1')
    expect(script).toContain('CODEX_TUI_SESSION_LOG_PATH')
    expect(script).toContain('task_started')
    expect(script).toContain('task_complete')
    expect(script).toContain('"kind":"codex_event"')
    expect(script).toContain('turn_completed')
    expect(script).toContain('PermissionRequest')
    expect(script).toContain('UserInputRequest')
    expect(script).toContain('/Users/txp/.orchestra/hooks/codex-notify.sh')
    expect(script).toContain('/Users/txp/.orchestra/bin')
    expect(script).not.toContain('"msg":{"type":"exec_command_end"')
  })
})
