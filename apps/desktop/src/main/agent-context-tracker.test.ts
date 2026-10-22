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

describe('AgentContextTracker claude pairing', () => {
  /** A project dir for `cwd` holding one transcript per [id, tokens], oldest first. */
  function project(dir: string, cwd: string, transcripts: Array<[string, number]>): string {
    const projectDir = path.join(dir, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]+/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcripts.forEach(([id, tokens], i) => {
      const file = path.join(projectDir, `${id}.jsonl`)
      fs.writeFileSync(file, assistantLine(`a-${id}`, '2026-10-22T20:00:00.000Z', tokens) + '\n')
      const t = new Date(Date.parse('2026-10-22T20:00:00.000Z') + i * 60_000)
      fs.utimesSync(file, t, t)
    })
    return projectDir
  }

  it('reads the conversation claude records for the pane’s pid, not the newest file', async () => {
    const dir = home()
    const cwd = '/repo/main'
    project(dir, cwd, [['quiet', 101_000], ['busy', 199_000]])
    fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'sessions', '11772.json'), JSON.stringify({ pid: 11772, sessionId: 'quiet', cwd }))

    const tracker = new AgentContextTracker({
      onChange: () => {},
      resolveCodexTranscript: () => null,
      resolveClaudePid: (id) => (id === 's1' ? 11772 : undefined),
      home: dir,
    })
    tracker.setSessions([{ sessionId: 's1', agent: 'claude', cwd }])
    await tick()
    expect(tracker.getAll().s1?.usedTokens).toBe(101_000)
    tracker.stop()
  })

  it('drops a neighbour’s guess when a hook claims that transcript', async () => {
    const dir = home()
    const cwd = '/repo/main'
    const projectDir = project(dir, cwd, [['quiet', 101_000], ['busy', 199_000]])

    const tracker = new AgentContextTracker({
      onChange: () => {},
      resolveCodexTranscript: () => null,
      home: dir,
    })
    // Re-adopted after a restart: the idle pane guesses the newest file.
    tracker.setSessions([{ sessionId: 'idle', agent: 'claude', cwd }])
    // @ts-expect-error — past the hook grace, so the guess may fire.
    tracker.entries.get('idle').trackedAt -= 10_000
    // @ts-expect-error — drive one poll synchronously.
    tracker.poll()
    expect(tracker.getAll().idle?.usedTokens).toBe(199_000)

    // The busy pane's hook names that file — the idle pane must let go of it.
    tracker.setSessions([
      { sessionId: 'idle', agent: 'claude', cwd },
      { sessionId: 'busy', agent: 'claude', cwd },
    ])
    tracker.noteClaudeTranscript('busy', path.join(projectDir, 'busy.jsonl'))
    // @ts-expect-error — the re-guess is past the grace too.
    tracker.entries.get('idle').trackedAt -= 10_000
    await tick()
    expect(tracker.getAll().busy?.usedTokens).toBe(199_000)
    expect(tracker.getAll().idle?.usedTokens).toBe(101_000)
    tracker.stop()
  })
})
