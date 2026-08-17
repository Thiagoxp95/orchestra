import { describe, it, expect } from 'vitest'
import { parseLaunchSelection } from './launch-selection'

describe('parseLaunchSelection', () => {
  it('reads the flags the desktop pins into every claude command', () => {
    expect(
      parseLaunchSelection('claude --model opus --effort high --dangerously-skip-permissions'),
    ).toEqual({ model: 'opus', effort: 'high' })
  })

  it('reads them after a --resume id (the resume launch shape)', () => {
    expect(parseLaunchSelection('claude --resume abc-123 --model fable --effort xhigh')).toEqual({
      model: 'fable',
      effort: 'xhigh',
    })
  })

  it("reads codex's -c effort override and its -m model", () => {
    expect(
      parseLaunchSelection(
        'codex -m gpt-5.5 -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox',
      ),
    ).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })

  it('reports only what the command names', () => {
    expect(parseLaunchSelection('codex -c model_reasoning_effort="medium"')).toEqual({
      effort: 'medium',
    })
    expect(parseLaunchSelection('claude')).toEqual({})
    expect(parseLaunchSelection('zsh')).toEqual({})
    expect(parseLaunchSelection(undefined)).toEqual({})
  })

  it('accepts --flag=value and quoted values', () => {
    expect(parseLaunchSelection("claude --model='opus' --effort=max")).toEqual({
      model: 'opus',
      effort: 'max',
    })
  })

  it('does not read a flag glued to a longer word', () => {
    // `--models` / `--no-model` must not answer for `--model`.
    expect(parseLaunchSelection('claude --no-model opus')).toEqual({})
  })
})
