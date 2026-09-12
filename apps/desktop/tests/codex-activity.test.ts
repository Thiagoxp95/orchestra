import { expect, it } from 'vitest'
import { CodexNotifyListener } from '../src/main/codex-notify-listener'
import { parseRolloutLine } from '../src/main/codex-rollout-watcher'
import { updateAgentInputBuffer } from '../src/renderer/src/utils/agent-input'
import { computeAgentView } from '../src/renderer/src/utils/agent-view-state'

it('replays draft paste, submission, child startup and parent completion into sidebar activity', () => {
  const listener = new CodexNotifyListener({ onStatusUpdate: () => {} })
  const view = () => computeAgentView({
    processStatus: 'codex',
    normalizedState: listener.getLatest('parent') ?? undefined,
    sessionNeedsUserInput: false,
  })
  const replay = (line: string) => {
    const event = parseRolloutLine(line)
    if (event) listener.applyExternalState('parent', event.state, 'codex-rollout')
  }

  listener.ingest({ sessionId: 'parent', event: 'SessionStart' })
  const pasted = updateAgentInputBuffer('', '\x1b[200~Debug report\rSessions\x1b[201~')
  if (pasted.submittedPrompt) listener.markRunStarted('parent')
  expect(view().isWorking).toBe(false)

  const submitted = updateAgentInputBuffer(pasted.nextBuffer, '\r')
  if (submitted.submittedPrompt) listener.markRunStarted('parent')
  expect(view().isWorking).toBe(true)

  replay('{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}')
  listener.ingest({ sessionId: 'parent', event: 'SessionStart', codexSessionId: 'child' })
  listener.ingest({ sessionId: 'parent', event: 'Stop', codexSessionId: 'child' })
  expect(view().isWorking).toBe(true)

  replay('{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}}')
  expect(view().isIdle).toBe(true)
  expect(view().isWorking).toBe(false)
})
