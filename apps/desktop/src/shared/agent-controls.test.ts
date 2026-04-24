import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_CONTROLS,
  mergeControls,
  parseSendExpression,
  resolveSendSteps,
  type Control,
  type SendStep,
} from './agent-controls'

describe('resolveSendSteps', () => {
  it('turns a text step into a single write', () => {
    const steps: SendStep[] = [{ kind: 'text', value: '/model' }]
    expect(resolveSendSteps(steps)).toEqual([{ kind: 'write', data: '/model' }])
  })

  it('turns the enter key into a carriage return write', () => {
    const steps: SendStep[] = [{ kind: 'key', value: 'enter' }]
    expect(resolveSendSteps(steps)).toEqual([{ kind: 'write', data: '\r' }])
  })

  it('turns shift-tab into the CSI Z escape sequence', () => {
    const steps: SendStep[] = [{ kind: 'key', value: 'shift-tab' }]
    expect(resolveSendSteps(steps)).toEqual([{ kind: 'write', data: '\x1b[Z' }])
  })

  it('turns tab, escape, and arrow keys into their byte sequences', () => {
    const steps: SendStep[] = [
      { kind: 'key', value: 'tab' },
      { kind: 'key', value: 'escape' },
      { kind: 'key', value: 'up' },
      { kind: 'key', value: 'down' },
    ]
    expect(resolveSendSteps(steps)).toEqual([
      { kind: 'write', data: '\t' },
      { kind: 'write', data: '\x1b' },
      { kind: 'write', data: '\x1b[A' },
      { kind: 'write', data: '\x1b[B' },
    ])
  })

  it('preserves wait steps between writes', () => {
    const steps: SendStep[] = [
      { kind: 'text', value: '/model' },
      { kind: 'key', value: 'enter' },
      { kind: 'wait', ms: 250 },
      { kind: 'key', value: 'down' },
    ]
    expect(resolveSendSteps(steps)).toEqual([
      { kind: 'write', data: '/model' },
      { kind: 'write', data: '\r' },
      { kind: 'wait', ms: 250 },
      { kind: 'write', data: '\x1b[B' },
    ])
  })
})

describe('parseSendExpression', () => {
  it('parses plain text as a single text step', () => {
    expect(parseSendExpression('hello')).toEqual([{ kind: 'text', value: 'hello' }])
  })

  it('parses {{enter}} as an enter key step', () => {
    expect(parseSendExpression('{{enter}}')).toEqual([{ kind: 'key', value: 'enter' }])
  })

  it('parses a command followed by enter', () => {
    expect(parseSendExpression('/model{{enter}}')).toEqual([
      { kind: 'text', value: '/model' },
      { kind: 'key', value: 'enter' },
    ])
  })

  it('parses {{wait:500}} as a wait step with ms', () => {
    expect(parseSendExpression('{{wait:500}}')).toEqual([{ kind: 'wait', ms: 500 }])
  })

  it('parses a full macro: /model, enter, wait, down, enter', () => {
    expect(parseSendExpression('/model{{enter}}{{wait:200}}{{down}}{{enter}}')).toEqual([
      { kind: 'text', value: '/model' },
      { kind: 'key', value: 'enter' },
      { kind: 'wait', ms: 200 },
      { kind: 'key', value: 'down' },
      { kind: 'key', value: 'enter' },
    ])
  })

  it('treats unknown {{tokens}} as literal text', () => {
    expect(parseSendExpression('hi {{bogus}} there')).toEqual([
      { kind: 'text', value: 'hi {{bogus}} there' },
    ])
  })

  it('returns an empty array for an empty string', () => {
    expect(parseSendExpression('')).toEqual([])
  })
})

describe('mergeControls', () => {
  const defaults: Control[] = [
    { id: 'a', label: 'A', entries: [{ id: 'a1', label: 'A1', send: [{ kind: 'text', value: 'a' }] }] },
  ]

  it('returns defaults when no override is provided', () => {
    expect(mergeControls(defaults, undefined)).toBe(defaults)
  })

  it('fully replaces defaults when an override array is provided', () => {
    const override: Control[] = [
      { id: 'b', label: 'B', entries: [{ id: 'b1', label: 'B1', send: [{ kind: 'text', value: 'b' }] }] },
    ]
    expect(mergeControls(defaults, override)).toBe(override)
  })

  it('treats an empty override array as "no controls" (intentional user removal)', () => {
    expect(mergeControls(defaults, [])).toEqual([])
  })
})

describe('DEFAULT_AGENT_CONTROLS', () => {
  it('ships at least one control for claude and codex', () => {
    expect(DEFAULT_AGENT_CONTROLS.claude.length).toBeGreaterThan(0)
    expect(DEFAULT_AGENT_CONTROLS.codex.length).toBeGreaterThan(0)
  })

  it('each default entry has a non-empty send sequence', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const control of DEFAULT_AGENT_CONTROLS[provider]) {
        for (const entry of control.entries) {
          expect(entry.send.length).toBeGreaterThan(0)
        }
      }
    }
  })
})
