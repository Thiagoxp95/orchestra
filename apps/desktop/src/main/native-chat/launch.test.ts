import { describe, expect, it } from 'vitest'
import { nativeLaunch } from './launch'
import { CLAUDE_INTERACTIVE_COMMAND_PREVIEW, CODEX_INTERACTIVE_COMMAND_PREVIEW, CURSOR_INTERACTIVE_COMMAND_PREVIEW, buildClaudeResumeCommand, buildCodexResumeCommand } from '../../shared/action-utils'
describe('native launch selection', () => {
  it('preserves standard provider/model/effort and exact resume ids', () => {
    expect(nativeLaunch(CLAUDE_INTERACTIVE_COMMAND_PREVIEW)).toEqual({ provider: 'claude', settings: { model: 'opus', effort: 'high' } })
    expect(nativeLaunch(CODEX_INTERACTIVE_COMMAND_PREVIEW)).toEqual({ provider: 'codex', settings: { effort: 'high' } })
    expect(nativeLaunch(CURSOR_INTERACTIVE_COMMAND_PREVIEW)).toEqual({ provider: 'cursor', settings: { model: 'composer-2-fast' } })
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(nativeLaunch(buildClaudeResumeCommand(id))?.conversationId).toBe(id)
    expect(nativeLaunch(buildCodexResumeCommand(id))?.conversationId).toBe(id)
  })
  it('does not drop custom prompts, commands or flags while replacing a CLI', () => {
    for (const command of ['claude "Fix the tests"', 'codex "Review this"', 'claude --append-system-prompt hi', 'claude --continue', 'codex resume --last', 'claude -p hi', 'codex exec hi', 'claude; echo hi', 'npm test']) expect(nativeLaunch(command), command).toBeNull()
  })
})
