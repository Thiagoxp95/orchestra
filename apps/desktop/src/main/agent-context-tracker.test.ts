import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentContextTracker } from './agent-context-tracker'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tracker-'))
  tmpDirs.push(dir)
  return dir
}

const userLine = (uuid: string, text: string, timestamp: string): string =>
  JSON.stringify({ type: 'user', uuid, timestamp, message: { role: 'user', content: text } })

const assistantLine = (uuid: string, timestamp: string, tokens: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: tokens, output_tokens: 0 },
    },
  })

/** Let the tracker's deferred poll (setTimeout 0) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('AgentContextTracker lastUserAt', () => {
  it('reports the person’s last message and keeps it once the agent scrolls it out', async () => {
    const dir = home()
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(
      file,
      [
        userLine('u1', 'do the thing', '2026-08-25T10:00:00.000Z'),
        assistantLine('a1', '2026-08-25T10:00:01.000Z', 1000),
      ].join('\n') + '\n',
    )

    const tracker = new AgentContextTracker({
      onChange: () => {},
      resolveCodexTranscript: () => null,
      home: dir,
    })
    tracker.noteClaudeTranscript('s1', file)
    tracker.setSessions([{ sessionId: 's1', agent: 'claude', cwd: dir }])
    await tick()
    expect(tracker.getAll().s1?.lastUserAt).toBe(Date.parse('2026-08-25T10:00:00.000Z'))

    // The agent runs long enough that the tail no longer reaches the message
    // that started it — simulated by rewriting the file without it.
    fs.writeFileSync(file, assistantLine('a2', '2026-08-25T13:00:00.000Z', 2000) + '\n')
    // @ts-expect-error — reach past the stat gate to force a re-read.
    tracker.entries.get('s1').stamp = ''
    // @ts-expect-error — same, drive one poll synchronously.
    tracker.poll()
    expect(tracker.getAll().s1?.lastUserAt).toBe(Date.parse('2026-08-25T10:00:00.000Z'))
    expect(tracker.getAll().s1?.usedTokens).toBe(2000)

    // …and a newer message replaces it.
    fs.appendFileSync(file, userLine('u2', 'and now this', '2026-08-25T14:00:00.000Z') + '\n')
    // @ts-expect-error — stat gate again.
    tracker.entries.get('s1').stamp = ''
    // @ts-expect-error
    tracker.poll()
    expect(tracker.getAll().s1?.lastUserAt).toBe(Date.parse('2026-08-25T14:00:00.000Z'))

    tracker.stop()
  })
})
