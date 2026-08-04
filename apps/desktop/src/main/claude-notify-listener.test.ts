import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { ClaudeNotifyListener, type ClaudeHookEvent } from './claude-notify-listener'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

async function postJson(port: number, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('ClaudeNotifyListener', () => {
  let listener: ClaudeNotifyListener
  let updates: NormalizedAgentSessionStatus[]

  const ingest = (
    event: ClaudeHookEvent,
    extra: { sessionId?: string; toolName?: string; agentId?: string } = {},
  ) => listener.ingest({ sessionId: extra.sessionId ?? 's1', event, ...extra })

  beforeEach(() => {
    updates = []
    listener = new ClaudeNotifyListener({
      onStatusUpdate: (status) => { updates.push(status) },
    })
  })

  afterEach(() => {
    listener.stop()
  })

  describe('event → state mapping', () => {
    it('maps UserPromptSubmit / tool events to working', () => {
      expect(ingest('UserPromptSubmit')?.state).toBe('working')
      // dedup collapses the identical follow-ups
      expect(ingest('PreToolUse', { toolName: 'Bash' })).toBeNull()
      expect(ingest('PostToolUse', { toolName: 'Bash' })).toBeNull()
      expect(listener.getLatest('s1')?.state).toBe('working')
      expect(listener.getLatest('s1')?.agent).toBe('claude')
      expect(listener.getLatest('s1')?.authority).toBe('claude-hook')
    })

    it('maps PermissionRequest to waitingApproval', () => {
      expect(ingest('PermissionRequest', { toolName: 'Bash' })?.state).toBe('waitingApproval')
    })

    it('maps a PreToolUse AskUserQuestion to waitingUserInput (not working)', () => {
      expect(ingest('PreToolUse', { toolName: 'AskUserQuestion' })?.state).toBe('waitingUserInput')
    })

    it('matches AskUserQuestion tool regardless of punctuation/case', () => {
      expect(ingest('PreToolUse', { toolName: 'ask_user_question' })?.state).toBe('waitingUserInput')
      expect(ingest('PreToolUse', { toolName: 'request_user_input', sessionId: 's2' })?.state)
        .toBe('waitingUserInput')
    })

    it('maps Stop and StopFailure to idle', () => {
      ingest('UserPromptSubmit')
      expect(ingest('Stop')?.state).toBe('idle')
      ingest('UserPromptSubmit')
      expect(ingest('StopFailure')?.state).toBe('idle')
    })

    it('dedups identical consecutive states', () => {
      expect(ingest('UserPromptSubmit')?.state).toBe('working')
      expect(ingest('PreToolUse', { toolName: 'Read' })).toBeNull()
    })

    it('ignores unmapped/unknown events', () => {
      expect(ingest('NotARealEvent' as ClaudeHookEvent)).toBeNull()
    })

    it('routes SessionStart transcriptPath without emitting any state', () => {
      const paths: [string, string][] = []
      listener.stop()
      listener = new ClaudeNotifyListener({
        onStatusUpdate: (status) => { updates.push(status) },
        onTranscriptPath: (sessionId, transcriptPath) => { paths.push([sessionId, transcriptPath]) },
      })
      // SessionStart fires while claude boots — including source `compact`
      // mid-turn — so it must pair the transcript without steering the pane.
      ingest('UserPromptSubmit')
      expect(listener.getLatest('s1')?.state).toBe('working')
      const result = listener.ingest({
        sessionId: 's1',
        event: 'SessionStart',
        transcriptPath: '/tmp/fresh.jsonl',
      })
      expect(result).toBeNull()
      expect(paths).toEqual([['s1', '/tmp/fresh.jsonl']])
      expect(listener.getLatest('s1')?.state).toBe('working')
    })
  })

  describe('subagent tracking', () => {
    it('keeps a pane working while a background child outlives the lead Stop', () => {
      ingest('UserPromptSubmit')                       // lead working
      ingest('SubagentStart', { agentId: 'a1' })       // child spawned (still working)
      // Lead finishes its turn but the child is still running — must NOT go idle.
      ingest('Stop')
      expect(listener.getLatest('s1')?.state).toBe('working')
      // Child finishes → the deferred idle now resolves.
      expect(ingest('SubagentStop', { agentId: 'a1' })?.state).toBe('idle')
      expect(listener.getLatest('s1')?.state).toBe('idle')
    })

    it('child-origin tool activity keeps the pane working without retiring the lead', () => {
      ingest('UserPromptSubmit')
      ingest('SubagentStart', { agentId: 'a1' })
      // A child's own tool events carry agent_id — they must not flip the lead.
      expect(ingest('PostToolUse', { toolName: 'Bash', agentId: 'a1' })).toBeNull() // already working
      // Lead Stop still deferred because the child is live.
      ingest('Stop')
      expect(listener.getLatest('s1')?.state).toBe('working')
    })

    it('surfaces a child that needs a human (approval) on the pane', () => {
      ingest('UserPromptSubmit')
      ingest('SubagentStart', { agentId: 'a1' })
      expect(ingest('PermissionRequest', { toolName: 'Bash', agentId: 'a1' })?.state)
        .toBe('waitingApproval')
    })

    it('resolves idle once the LAST child of several drains', () => {
      ingest('UserPromptSubmit')
      ingest('SubagentStart', { agentId: 'a1' })
      ingest('SubagentStart', { agentId: 'a2' })
      ingest('Stop')                                   // deferred — two children live
      expect(ingest('SubagentStop', { agentId: 'a1' })).toBeNull() // still one child
      expect(listener.getLatest('s1')?.state).toBe('working')
      expect(ingest('SubagentStop', { agentId: 'a2' })?.state).toBe('idle')
    })
  })

  describe('OSC-title reconciliation', () => {
    const title = (state: 'idle' | 'working' | 'waitingUserInput', sessionId = 's1') =>
      listener.applyExternalState(sessionId, state, 'claude-osc')

    it('clears a turn the user interrupted (Esc fires no Stop hook)', () => {
      ingest('UserPromptSubmit')
      ingest('PreToolUse', { toolName: 'Bash' })
      // User hits Esc: claude emits no Stop, no StopFailure, no PostToolUse —
      // the hook stream just goes silent with 'working' latched.
      expect(listener.getLatest('s1')?.state).toBe('working')

      const corrected = title('idle')
      expect(corrected?.state).toBe('idle')
      expect(corrected?.authority).toBe('claude-osc')
    })

    it('resolves a leaked subagent roster whose SubagentStop never arrived', () => {
      ingest('UserPromptSubmit')
      ingest('SubagentStart', { agentId: 'a1' })
      ingest('Stop')                                   // deferred — child still live
      expect(listener.getLatest('s1')?.state).toBe('working')

      expect(title('idle')?.state).toBe('idle')
      // Roster is gone, so the next turn's Stop is not deferred against a ghost.
      ingest('UserPromptSubmit')
      expect(ingest('Stop')?.state).toBe('idle')
    })

    it('surfaces the TUI picker as waitingUserInput while the hooks say working', () => {
      ingest('UserPromptSubmit')
      expect(title('waitingUserInput')?.state).toBe('waitingUserInput')
      // Dismissing the picker fires no hook of its own — the title retires it.
      expect(title('idle')?.state).toBe('idle')
    })

    it('seeds working when the hook stream never spoke for this session', () => {
      expect(title('working')?.state).toBe('working')
      expect(listener.getLatest('s1')?.authority).toBe('claude-osc')
      // A later hook event still owns the session from there on.
      expect(ingest('Stop')?.state).toBe('idle')
    })

    it('never clears a state only the hooks can see', () => {
      ingest('PermissionRequest', { toolName: 'Bash' })
      expect(title('idle')).toBeNull()
      expect(title('working')).toBeNull()
      expect(listener.getLatest('s1')?.state).toBe('waitingApproval')

      ingest('PreToolUse', { toolName: 'AskUserQuestion', sessionId: 's2' })
      expect(title('working', 's2')).toBeNull()
      expect(listener.getLatest('s2')?.state).toBe('waitingUserInput')
    })

    it('dedups a title that agrees with the cached state', () => {
      ingest('UserPromptSubmit')
      expect(title('working')).toBeNull()
      ingest('Stop')
      expect(title('idle')).toBeNull()
    })

    it('honors isKnownSession gate', () => {
      const gated = new ClaudeNotifyListener({
        onStatusUpdate: (s) => { updates.push(s) },
        isKnownSession: (id) => id === 'allowed',
      })
      expect(gated.applyExternalState('blocked', 'working', 'claude-osc')).toBeNull()
      expect(gated.applyExternalState('allowed', 'working', 'claude-osc')?.state).toBe('working')
      gated.stop()
    })
  })

  describe('session lifecycle', () => {
    it('honors isKnownSession gate', () => {
      const gated = new ClaudeNotifyListener({
        onStatusUpdate: (s) => { updates.push(s) },
        isKnownSession: (id) => id === 'allowed',
      })
      expect(gated.ingest({ sessionId: 'blocked', event: 'UserPromptSubmit' })).toBeNull()
      expect(gated.ingest({ sessionId: 'allowed', event: 'UserPromptSubmit' })?.state).toBe('working')
      gated.stop()
    })

    it('forgetSession clears cached state and roster', () => {
      ingest('UserPromptSubmit')
      ingest('SubagentStart', { agentId: 'a1' })
      listener.forgetSession('s1')
      expect(listener.getLatest('s1')).toBeNull()
      // A fresh Stop after forget starts from a clean slate (no live roster to
      // defer against) — resolves straight to idle.
      expect(ingest('Stop')?.state).toBe('idle')
    })
  })

  describe('http transport', () => {
    it('accepts a POST to /claude-hook and emits normalized status', async () => {
      const port = await listener.start()
      const res = await postJson(port, '/claude-hook', { sessionId: 's9', event: 'UserPromptSubmit' })
      expect(res.status).toBe(204)
      expect(listener.getLatest('s9')?.state).toBe('working')
    })

    it('rejects a non-hook path with 404', async () => {
      const port = await listener.start()
      const res = await postJson(port, '/nope', { sessionId: 's9', event: 'Stop' })
      expect(res.status).toBe(404)
    })

    it('rejects a malformed body with 400', async () => {
      const port = await listener.start()
      const res = await fetch(`http://127.0.0.1:${port}/claude-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  // Claude's RAW PreToolUse payload, forwarded verbatim on its own endpoint
  // because tool_input is a nested object the mapped payload can't carry.
  describe('/claude-question', () => {
    let questions: Array<{ sessionId: string; toolUseId: string; toolInput: unknown }>

    const postRaw = async (port: number, body: unknown, sessionId?: string) =>
      fetch(`http://127.0.0.1:${port}/claude-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'X-Orchestra-Session': sessionId } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })

    // Shape captured from a real claude-code 2.1.221 hook payload.
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_01Bx',
      transcript_path: '/tmp/t.jsonl',
      tool_input: { questions: [{ question: 'Which?', options: [{ label: 'a' }] }] },
    }

    beforeEach(() => {
      questions = []
      listener.stop()
      listener = new ClaudeNotifyListener({
        onStatusUpdate: (status) => { updates.push(status) },
        onQuestion: (sessionId, toolUseId, toolInput) => {
          questions.push({ sessionId, toolUseId, toolInput })
        },
      })
    })

    it('reports the form with the session from the header', async () => {
      const port = await listener.start()
      const res = await postRaw(port, payload, 's9')
      expect(res.status).toBe(204)
      expect(questions).toEqual([
        { sessionId: 's9', toolUseId: 'toolu_01Bx', toolInput: payload.tool_input },
      ])
    })

    it('ignores a payload with no session header, no tool_use_id, or another tool', async () => {
      const port = await listener.start()
      await postRaw(port, payload) // no session header
      await postRaw(port, { ...payload, tool_use_id: undefined }, 's9')
      await postRaw(port, { ...payload, tool_name: 'Bash' }, 's9')
      await postRaw(port, 'not json', 's9')
      expect(questions).toHaveLength(0)
    })

    it('accepts any AskUserQuestion spelling', async () => {
      const port = await listener.start()
      await postRaw(port, { ...payload, tool_name: 'ask_user_question' }, 's9')
      expect(questions).toHaveLength(1)
    })
  })
})
