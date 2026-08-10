import { describe, expect, it } from 'vitest'
import { makeEcho } from './chat-messages'
import { ECHO_MAX_AGE_MS, loadEchoes, parkEchoes } from './pending-echoes'

describe('pending echo park', () => {
  it('hands a fresh mount the echoes the last one was holding', () => {
    // The case this exists for: send into a working agent, flick to Term to
    // watch the TUI, come back. ChatPane is unmounted by that round trip, and
    // the transcript may not carry the message for minutes.
    parkEchoes('s1', [makeEcho('and the migration', 7, 'n1', 1_000)])
    expect(loadEchoes('s1', 2_000).map((e) => e.message.uid)).toEqual(['local:n1'])
  })

  it('keeps sessions apart and forgets a session with nothing in flight', () => {
    parkEchoes('s1', [makeEcho('one', 1, 'n1', 1_000)])
    parkEchoes('s2', [])
    expect(loadEchoes('s2', 2_000)).toEqual([])
    expect(loadEchoes('s1', 2_000)).toHaveLength(1)
    parkEchoes('s1', [])
    expect(loadEchoes('s1', 2_000)).toEqual([])
  })

  it('drops an echo whose real message never arrived', () => {
    // Without the age cap a send into a PTY that then died would sit at the end
    // of the conversation for the life of the tab.
    parkEchoes('s1', [makeEcho('lost', 1, 'n1', 1_000)])
    expect(loadEchoes('s1', 1_000 + ECHO_MAX_AGE_MS)).toEqual([])
    expect(loadEchoes('s1', 1_000 + ECHO_MAX_AGE_MS)).toEqual([])
  })
})
