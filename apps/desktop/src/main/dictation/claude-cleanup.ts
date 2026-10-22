// src/main/dictation/claude-cleanup.ts
//
// The cleanup through `claude -p` on this Mac when no OpenRouter key is saved:
// the user's subscription, no key. A cold CLI takes ~3.5 s, so one waits warm;
// each dictation gets its own, so none hears the last, and the next starts
// once this one answered (one booting beside the turn slowed it ~0.5 s).
//
// It runs from its own directory with project-only settings and no hooks, and
// keeps no session file, so it never shows up as an agent session.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildCliChildEnv } from '../node-runtime'

/** Sonnet: as quick as Haiku through the CLI (~2 s), and Haiku kept "no, wait" self-corrections in (2026-10-22). */
const MODEL = 'sonnet'
const TIMEOUT_MS = 30_000

function findClaude(): string {
  // The real binary, not Orchestra's wrapper in ~/.orchestra/bin.
  const candidates = [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return candidates.find((c) => existsSync(c)) ?? 'claude'
}

let spare: ChildProcessWithoutNullStreams | null = null

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

function alive(proc: ChildProcessWithoutNullStreams | null): proc is ChildProcessWithoutNullStreams {
  return !!proc && proc.exitCode === null && proc.signalCode === null
}

export function warmClaude(system: string): void {
  if (!alive(spare)) spare = spawnCli(system)
}

export function stopClaude(): void {
  spare?.kill()
  spare = null
}

export async function askClaude(system: string, user: string): Promise<string> {
  const proc = alive(spare) ? spare : spawnCli(system)
  spare = null
  try {
    return await new Promise<string>((resolve, reject) => {
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
  } finally {
    proc.kill()
    warmClaude(system)
  }
}
