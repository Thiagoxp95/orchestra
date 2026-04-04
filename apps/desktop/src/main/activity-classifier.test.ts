// apps/desktop/src/main/activity-classifier.test.ts
import { describe, it, expect } from 'vitest'
import { classifyActivity } from './activity-classifier'

describe('activity-classifier', () => {
  it('detects interrupted state', () => {
    const buffer = 'some output\nInterrupted · What should Claude do instead?\n'
    expect(classifyActivity(buffer)).toBe('interrupted')
  })

  it('detects permission_request from yes/no dialog', () => {
    const buffer = 'Do you want to execute this command?\n  Yes  No\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('detects permission_request from allow/deny pattern', () => {
    const buffer = 'Allow this action?\n  Allow  Deny\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('detects thinking state from spinner verb', () => {
    const buffer = 'some previous output\n✻ Thinking\n'
    expect(classifyActivity(buffer)).toBe('thinking')
  })

  it('detects thinking with various spinner chars', () => {
    expect(classifyActivity('output\n✳ Pondering\n')).toBe('thinking')
    expect(classifyActivity('output\n✶ Contemplating\n')).toBe('thinking')
    expect(classifyActivity('output\n· Reasoning\n')).toBe('thinking')
  })

  it('detects tool_executing from tool name near spinner', () => {
    expect(classifyActivity('output\n✻ Read src/index.ts\n')).toBe('tool_executing')
    expect(classifyActivity('output\n✳ Bash npm test\n')).toBe('tool_executing')
    expect(classifyActivity('output\n· Edit file.ts\n')).toBe('tool_executing')
    expect(classifyActivity('output\n✶ Write new-file.ts\n')).toBe('tool_executing')
  })

  it('detects turn_complete from past-tense verb with duration', () => {
    expect(classifyActivity('output\nBaked for 5s\n')).toBe('turn_complete')
    expect(classifyActivity('output\nWorked for 2.3s\n')).toBe('turn_complete')
    expect(classifyActivity('output\nCrunched for 12s\n')).toBe('turn_complete')
  })

  it('returns null when no pattern matches', () => {
    expect(classifyActivity('just some random text output')).toBeNull()
  })

  it('returns null for empty buffer', () => {
    expect(classifyActivity('')).toBeNull()
  })

  it('prioritizes interrupted over other states', () => {
    const buffer = '✻ Thinking\nInterrupted · What should Claude do instead?\n'
    expect(classifyActivity(buffer)).toBe('interrupted')
  })

  it('prioritizes permission_request over thinking', () => {
    const buffer = '✻ Thinking\nAllow this action?\n  Yes  No\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('only scans the tail of the buffer', () => {
    // "Interrupted" far back in buffer should not trigger — only tail matters
    const old = 'Interrupted\n'
    const padding = 'x\n'.repeat(200)
    const recent = '✻ Thinking\n'
    expect(classifyActivity(old + padding + recent)).toBe('thinking')
  })
})
