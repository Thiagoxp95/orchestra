// src/main/dictation/claude-cleanup.ts
//
// The cleanup through `claude -p` on this Mac when no OpenRouter key is saved:
// the user's subscription, no key. Each question goes to two CLIs at once and
// the first answer wins: the API took 1 to 8.6 s for the same Sonnet prompt
// (2026-11-02), and the slower of two draws is the one a dictation used to wait
// on. A cold CLI costs ~0.5 s more, so two wait warm; each dictation gets its
// own, so none hears the last, and the next two start once this one answered
// (one booting beside the turn slowed it ~0.5 s).
//
// It runs from its own directory with project-only settings and no hooks, and
// keeps no session file, so it never shows up as an agent session.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildCliChildEnv } from '../node-runtime'

/** Sonnet. Haiku answers 2-3x sooner but, on 2026-11-02, kept "Tuesday. No. Wednesday." and dropped words that carried meaning. */
const MODEL = 'sonnet'
const TIMEOUT_MS = 30_000

function findClaude(): string {
  // The real binary, not Orchestra's wrapper in ~/.orchestra/bin.
  const candidates = [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return candidates.find((c) => existsSync(c)) ?? 'claude'
}

/** CLIs asked per question; the first to answer wins. */
const HEDGE = 2

let spares: ChildProcessWithoutNullStreams[] = []

function spawnCli(system: string): ChildProcessWithoutNullStreams {
  const cwd = join(homedir(), '.orchestra', 'dictation')
  mkdirSync(cwd, { recursive: true })
  const proc = spawn(
    findClaude(),
    [
      '-p', '--model', MODEL, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
      '--setting-sources', 'project', '--no-session-persistence',
      '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ],
    { cwd, env: buildCliChildEnv(), stdio: ['pipe', 'pipe', 'ignore'] },
  ) as unknown as ChildProcessWithoutNullStreams
  proc.on('error', () => {})
  return proc
}

function alive(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

export function warmClaude(system: string): void {
  spares = spares.filter(alive)
  while (spares.length < HEDGE) spares.push(spawnCli(system))
}

export function stopClaude(): void {
  for (const proc of spares) proc.kill()
  spares = []
}

function take(system: string): ChildProcessWithoutNullStreams {
  spares = spares.filter(alive)
  return spares.shift() ?? spawnCli(system)
}

function ask(proc: ChildProcessWithoutNullStreams, user: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('claude -p took too long')), TIMEOUT_MS)
    let buf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        let event: { type?: string; is_error?: boolean; result?: string }
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type !== 'result') continue
        clearTimeout(timer)
        if (event.is_error) reject(new Error(event.result || 'claude -p failed'))
        else resolve(event.result ?? '')
      }
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      reject(new Error('claude -p exited'))
    })
    proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: user } })}\n`)
  })
}

/** The first answer of HEDGE CLIs; rejects when all fail or [signal] aborts, and stops them all either way. */
export async function askClaude(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const procs = Array.from({ length: HEDGE }, () => take(system))
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(new Error('superseded'))
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([Promise.any(procs.map((proc) => ask(proc, user))), aborted])
  } catch (err) {
    throw err instanceof AggregateError ? err.errors[0] : err
  } finally {
    for (const proc of procs) proc.kill()
    warmClaude(system)
  }
}
