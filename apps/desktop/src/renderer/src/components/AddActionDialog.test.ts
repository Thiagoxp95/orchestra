import { describe, expect, it } from 'vitest'

import { getActionSaveBlocker } from './AddActionDialog'

describe('getActionSaveBlocker', () => {
  it('explains the hidden missing name when an agent prompt is filled', () => {
    expect(getActionSaveBlocker('', 'Fix the failing tests', 'claude')).toBe('Add an action name to save.')
  })

  it('uses agent prompt copy for missing agent commands', () => {
    expect(getActionSaveBlocker('Fix tests', '', 'codex')).toBe('Add a prompt to save.')
  })

  it('uses command copy for missing CLI commands', () => {
    expect(getActionSaveBlocker('Run tests', '', 'cli')).toBe('Add a command to save.')
  })

  it('allows saving once the required fields are present', () => {
    expect(getActionSaveBlocker('Fix tests', 'bun test', 'cli')).toBeNull()
  })
})
