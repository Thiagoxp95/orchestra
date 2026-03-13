import { describe, expect, it } from 'vitest'
import { buildActionCommand, getCodexShellCommandBinary } from './action-utils'
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
  it('builds the default Codex shell command', () => {
    expect(buildActionCommand(makeAction())).toBe(
      'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
    )
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
})
