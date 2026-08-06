import { describe, expect, it } from 'vitest'
import {
  buildActionCommand,
  buildAgentResumeCommand,
  buildAutomationCommand,
  buildClaudeResumeCommand,
  buildCodexResumeCommand,
  isAgentResumeCommand,
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
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
    expect(CLAUDE_INTERACTIVE_COMMAND_PREVIEW).toBe('claude --model opus --effort high --dangerously-skip-permissions')
    expect(CLAUDE_PRINT_COMMAND_PREVIEW).toBe('claude -p --model opus --effort high --dangerously-skip-permissions')
    expect(CODEX_INTERACTIVE_COMMAND_PREVIEW).toBe(
      'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_PRINT_COMMAND_PREVIEW).toBe(
      'codex -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_INTERACTIVE_SHELL_COMMAND_PREVIEW).toBe(
      'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
    expect(CODEX_PRINT_SHELL_COMMAND_PREVIEW).toBe(
      'codex -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
  })

  it('builds the default Codex shell command', () => {
    expect(buildActionCommand(makeAction())).toBe(
      'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
  })

  it('launches a blank interactive Claude session bare (no /remote-control)', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      icon: '__claude__',
      name: 'Claude',
    }))).toBe('claude --model opus --effort high --dangerously-skip-permissions')
  })

  it('does not inject /remote-control when the Claude action has a prompt', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      command: 'review the diff',
    }))).toBe("claude --model opus --effort high --dangerously-skip-permissions 'review the diff'")
  })

  it('does not inject /remote-control for print-mode Claude actions', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      printMode: true,
    }))).toBe('claude -p --model opus --effort high --dangerously-skip-permissions')
  })

  it('passes print mode and the optional prompt through as shell args', () => {
    expect(buildActionCommand(makeAction({
      printMode: true,
      command: 'summarize the repo',
    }))).toBe(
      'codex -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true \'summarize the repo\''
    )
  })

  it('uses the Codex binary from PATH', () => {
    expect(getCodexShellCommandBinary()).toBe('codex')
  })

  it('pins the house model/effort on every Claude launch, so a phone-side /model cannot follow the next session', () => {
    // `/model` and `/effort` typed into a live TUI persist into
    // ~/.claude/settings.json as the account default; these per-session flags
    // are what keep that switch scoped to the one chat it was made in.
    const flags = `--model ${CLAUDE_DEFAULT_MODEL} --effort ${CLAUDE_DEFAULT_EFFORT}`
    expect(CLAUDE_INTERACTIVE_COMMAND_PREVIEW).toContain(flags)
    expect(CLAUDE_PRINT_COMMAND_PREVIEW).toContain(flags)
    expect(buildActionCommand(makeAction({ actionType: 'claude' }))).toContain(flags)
    expect(buildAutomationCommand(makeAction({ actionType: 'claude', command: 'sweep' }))).toContain(flags)
    // …and a resume still leads with the id, which the resume matchers key off.
    expect(buildClaudeResumeCommand('sess-1')).toBe(
      `claude --resume sess-1 ${flags} --dangerously-skip-permissions`,
    )
    expect(isAgentResumeCommand(buildClaudeResumeCommand('sess-1'))).toBe(true)
  })

  it('passes Claude model and effort options through as startup flags', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      agentModel: 'opusplan',
      agentReasoningEffort: 'xhigh',
      command: 'plan the refactor',
    }))).toBe(
      'claude --model opusplan --effort xhigh --dangerously-skip-permissions \'plan the refactor\''
    )
  })

  it('passes Codex model and reasoning effort options through as startup flags', () => {
    expect(buildActionCommand(makeAction({
      agentModel: 'gpt-5.4-codex',
      agentReasoningEffort: 'medium',
      command: 'fix tests',
    }))).toBe(
      'codex --model gpt-5.4-codex -c model_reasoning_effort="medium" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true \'fix tests\''
    )
  })

  it('adds stream-json only for automation-stream Claude print runs', () => {
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      printMode: true,
      command: 'nightly review',
    }), { automationStream: true })).toBe(
      "claude -p --output-format stream-json --verbose --model opus --effort high --dangerously-skip-permissions 'nightly review'"
    )
    // Interactive (non-print) Claude never gets stream flags.
    expect(buildActionCommand(makeAction({
      actionType: 'claude',
      command: 'nightly review',
    }), { automationStream: true })).toBe(
      "claude --model opus --effort high --dangerously-skip-permissions 'nightly review'"
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

describe('buildAutomationCommand', () => {
  it('forces print mode and streams JSON for Claude actions', () => {
    expect(buildAutomationCommand(makeAction({
      actionType: 'claude',
      command: 'run the 5h maintenance sweep',
    }))).toBe(
      "claude -p --output-format stream-json --verbose --model opus --effort high --dangerously-skip-permissions 'run the 5h maintenance sweep'"
    )
  })

  it('forces quiet mode for Codex actions without stream flags', () => {
    expect(buildAutomationCommand(makeAction({
      command: 'fix tests',
    }))).toBe(
      'codex -q -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true \'fix tests\''
    )
  })

  it('leaves CLI actions untouched', () => {
    expect(buildAutomationCommand(makeAction({
      actionType: 'cli',
      command: 'npm run nightly',
    }))).toBe('npm run nightly')
  })
})

describe('resume commands', () => {
  it('resumes Claude with bypassed permissions', () => {
    expect(buildClaudeResumeCommand('9e0e82c9-2ea4-44e1-991d-de637fe3b117')).toBe(
      'claude --resume 9e0e82c9-2ea4-44e1-991d-de637fe3b117 --model opus --effort high --dangerously-skip-permissions'
    )
  })

  it('resumes Codex with the same flags a fresh launch gets', () => {
    expect(buildCodexResumeCommand('019f8bf7-7b1a-7e72-a9cc-1183aaa6cae0')).toBe(
      'codex resume 019f8bf7-7b1a-7e72-a9cc-1183aaa6cae0 -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
  })

  it('quotes session ids that are not plain tokens', () => {
    expect(buildAgentResumeCommand('claude', "weird id'")).toBe(
      "claude --resume 'weird id'\\''' --model opus --effort high --dangerously-skip-permissions"
    )
  })

  it('recognises resume launches as interactive, not one-shot runs', () => {
    expect(isAgentResumeCommand(buildClaudeResumeCommand('abc'))).toBe(true)
    expect(isAgentResumeCommand(buildCodexResumeCommand('abc'))).toBe(true)
    expect(isAgentResumeCommand(CLAUDE_INTERACTIVE_COMMAND_PREVIEW)).toBe(false)
    expect(isAgentResumeCommand(CODEX_INTERACTIVE_COMMAND_PREVIEW)).toBe(false)
    expect(isAgentResumeCommand("claude --dangerously-skip-permissions 'resume the work'")).toBe(false)
    expect(isAgentResumeCommand(undefined)).toBe(false)
  })
})
