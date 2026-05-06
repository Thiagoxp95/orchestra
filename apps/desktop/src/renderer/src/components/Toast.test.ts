import { describe, expect, it } from 'vitest'

import { buildToastCopy } from './Toast'

describe('buildToastCopy', () => {
  it('uses the session label as the primary toast text and keeps agent identity out of the status line', () => {
    expect(buildToastCopy({
      agentType: 'codex',
      requiresUserInput: false,
      title: "We've been trying to fix this for so long",
      sessionTitle: "We've been trying to fix this for so long",
    })).toEqual({
      primaryText: "We've been trying to fix this for so long",
      statusText: 'Finished',
    })
  })

  it('marks attention toasts without saying the agent is done', () => {
    expect(buildToastCopy({
      agentType: 'claude',
      requiresUserInput: true,
      title: 'Pick the migration approach',
      sessionTitle: 'Fix billing migration',
    })).toEqual({
      primaryText: 'Fix billing migration',
      statusText: 'Needs input',
    })
  })
})
