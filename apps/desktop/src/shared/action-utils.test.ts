import { describe, expect, it } from 'vitest'
import {
  buildActionCommand,
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CLAUDE_PRINT_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW,
  CODEX_PRINT_COMMAND_PREVIEW,
  CODEX_PRINT_SHELL_COMMAND_PREVIEW,
  getCodexShellCommandBinary,
  isCodexInteractiveInitialCommand,
} from './action-utils'
import type { CustomAction } from './types'

function makeAction(overrides: Partial<CustomAction> = {}): CustomAction {
  return {
    id: 'action-1',
    name: 'Codex',
    icon: '__openai__',
    command: '',
    actionType: 'codex',
    keybinding: 'Cmd+O',
    runOnWorktreeCreation: false,
    ...overrides,
  }
}

describe('buildActionCommand', () => {
  it('exports stable default command previews for interactive agents', () => {
    expect(CLAUDE_INTERACTIVE_COMMAND_PREVIEW).toBe('claude --dangerously-skip-permissions')
    expect(CLAUDE_PRINT_COMMAND_PREVIEW).toBe('claude -p --dangerously-skip-permissions')
    expect(CODEX_INTERACTIVE_COMMAND_PREVIEW).toBe(
      'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_PRINT_COMMAND_PREVIEW).toBe(
      'codex -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_PRINT_SHELL_COMMAND_PREVIEW).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
  })

  it('builds the default Codex shell command', () => {
    expect(buildActionCommand(makeAction())).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
  })

  it('builds the default Claude shell command', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      icon: '__claude__',
      name: 'Claude',
    }))).toBe('ORCHESTRA_CLAUDE_BIN="$HOME/.orchestra-dev/bin/claude"; [ -x "$ORCHESTRA_CLAUDE_BIN" ] || ORCHESTRA_CLAUDE_BIN="$HOME/.orchestra/bin/claude"; "$ORCHESTRA_CLAUDE_BIN" --dangerously-skip-permissions')
  })

  it('passes print mode and the optional prompt through as shell args', () => {
    expect(buildActionCommand(makeAction({
      printMode: true,
      command: 'summarize the repo',
    }))).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true \'summarize the repo\''
    )
  })

  it('resolves the dev wrapper first and falls back to production', () => {
    expect(getCodexShellCommandBinary()).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN"'
    )
  })

  it('recognizes interactive Codex startup commands with or without a prompt', () => {
    expect(isCodexInteractiveInitialCommand('codex')).toBe(true)
    expect(isCodexInteractiveInitialCommand('codex "fix the bug"')).toBe(true)
    expect(isCodexInteractiveInitialCommand(CODEX_INTERACTIVE_COMMAND_PREVIEW)).toBe(true)
    expect(isCodexInteractiveInitialCommand(`${CODEX_INTERACTIVE_COMMAND_PREVIEW} 'fix the bug'`)).toBe(true)
    expect(isCodexInteractiveInitialCommand(CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW)).toBe(true)
    expect(isCodexInteractiveInitialCommand('codex -q "summarize"')).toBe(false)
    expect(isCodexInteractiveInitialCommand('codex resume thread-123')).toBe(false)
    expect(isCodexInteractiveInitialCommand(CODEX_PRINT_COMMAND_PREVIEW)).toBe(false)
    expect(isCodexInteractiveInitialCommand(undefined)).toBe(false)
  })
})
