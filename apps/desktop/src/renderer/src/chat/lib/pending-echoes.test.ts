import { describe, expect, it } from 'vitest'
import { makeEcho } from './chat-messages'
import {
  ECHO_MAX_AGE_MS,
  getEchoSnapshot,
  loadEchoes,
  parkEchoes,
  subscribeEchoes,
  updateEchoes,
} from './pending-echoes'

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

describe('observable pending echoes', () => {
  it('returns one stable snapshot for sessions with no echoes', () => {
    expect(loadEchoes('desktop-empty-a')).toBe(loadEchoes('desktop-empty-b'))
  })

  it('publishes a rejected send to the next mount of the same session', () => {
    parkEchoes('desktop-rejected', [makeEcho('send me', 1, 'reject', Date.now())])
    let oldMountCalls = 0
    const unmount = subscribeEchoes('desktop-rejected', () => oldMountCalls++)
    unmount()
    const seen: string[][] = []
    const unsubscribe = subscribeEchoes('desktop-rejected', () => {
      seen.push(loadEchoes('desktop-rejected').map((echo) => echo.message.uid))
    })

    updateEchoes('desktop-rejected', (current) =>
      current.filter((echo) => echo.message.uid !== 'local:reject'),
    )
    unsubscribe()

    expect(oldMountCalls).toBe(0)
    expect(seen).toEqual([[]])
  })

  it('keeps the snapshot stable and skips notification for an equivalent update', () => {
    const held = [makeEcho('same', 1, 'same', Date.now())]
    parkEchoes('desktop-stable', held)
    let calls = 0
    const unsubscribe = subscribeEchoes('desktop-stable', () => calls++)

    const next = updateEchoes('desktop-stable', (current) => [...current])
    unsubscribe()

    expect(next).toBe(held)
    expect(calls).toBe(0)
  })

  it('does not notify another session or a cleaned-up subscription', () => {
    let calls = 0
    const unsubscribe = subscribeEchoes('desktop-watched', () => calls++)

    parkEchoes('desktop-other', [makeEcho('other', 1, 'other', Date.now())])
    unsubscribe()
    parkEchoes('desktop-watched', [makeEcho('watched', 1, 'watched', Date.now())])

    expect(calls).toBe(0)
  })

  it('prunes expired echoes when subscribing while snapshot reads stay stable', () => {
    parkEchoes('desktop-expired-on-mount', [makeEcho('lost', 1, 'lost', 1)])
    const before = getEchoSnapshot('desktop-expired-on-mount')
    expect(getEchoSnapshot('desktop-expired-on-mount')).toBe(before)

    const unsubscribe = subscribeEchoes('desktop-expired-on-mount', () => {})
    unsubscribe()

    expect(getEchoSnapshot('desktop-expired-on-mount')).toEqual([])
  })
})
