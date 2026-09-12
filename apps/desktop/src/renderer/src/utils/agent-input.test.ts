import { describe, expect, it } from 'vitest'
import { updateAgentInputBuffer } from './agent-input'

describe('agent prompt submission', () => {
  it('keeps a multiline bracketed paste idle until Enter is pressed', () => {
    const pasted = updateAgentInputBuffer('', '\x1b[200~Debug report\r\nSessions\r\nStill typing\x1b[201~')
    expect(pasted.submittedPrompt).toBe(false)
    expect(pasted.nextBuffer).toContain('Still typing')
    expect(updateAgentInputBuffer(pasted.nextBuffer, '\r').submittedPrompt).toBe(true)
  })

  it('does not submit ordinary typing or an empty Enter', () => {
    expect(updateAgentInputBuffer('', 'hello').submittedPrompt).toBe(false)
    expect(updateAgentInputBuffer('', '\r').submittedPrompt).toBe(false)
    expect(updateAgentInputBuffer('hello', '\r')).toEqual({ nextBuffer: '', submittedPrompt: true })
  })
})
