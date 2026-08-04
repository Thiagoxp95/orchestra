// Pairing a *resumed* claude session with the transcript it continues.
//
// Both transcript consumers (AgentContextTracker, AgentMessageMirror) find a
// claude session's JSONL either from a hook report or, failing that, by guessing
// the newest file in the project directory derived from the session's cwd. A
// resume defeats both:
//
//  - The cwd guess looks in `~/.claude/projects/<slug-of-cwd>`, and a resume runs
//    in the directory the conversation RECORDED, which is routinely a
//    subdirectory of the one claude was originally launched from (`apps/web`
//    under the repo root). Claude keeps writing to the original project dir, so
//    the slug for the resumed cwd names a directory that often doesn't exist —
//    the guess then returns nothing, forever.
//  - The hook report only lands at SessionStart or on the first prompt, so a
//    conversation resumed and merely *looked at* on the phone stays unpaired:
//    the terminal mirrors fine (raw PTY bytes) while the chat view stays empty
//    until the user types.
//
// But the pairing is not a guess at all here: the resume command carries the
// conversation id, and the file is `<some project dir>/<id>.jsonl`. This module
// recovers it, and remote-bridge feeds it to both consumers as an authoritative
// path — the same channel a hook report uses, so a later report simply wins.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * The conversation id out of a claude resume command, or null for anything else.
 * The inverse of buildClaudeResumeCommand (shared/action-utils), which quotes
 * the id only when it isn't already a bare shell token — so accept both forms,
 * plus the `-r` short flag isAgentResumeCommand also recognizes.
 */
export function parseClaudeResumeId(command: string | undefined): string | null {
  if (!command) return null
  const match = /^\s*(?:\S*\/)?claude\s+(?:--resume|-r)\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(command)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

export interface FindClaudeTranscriptByIdOptions {
  home?: string
  /** Injected for tests; defaults to a real read of ~/.claude/projects. */
  readdir?: (dir: string) => string[]
  exists?: (file: string) => boolean
}

/**
 * Locate `<id>.jsonl` across every claude project directory. Which slug holds it
 * depends on where claude was FIRST launched, which the resume no longer knows,
 * so all of them are checked — a few hundred cheap stats, once per resumed
 * session (remote-bridge memoizes the answer).
 */
export function findClaudeTranscriptById(
  claudeSessionId: string,
  opts: FindClaudeTranscriptByIdOptions = {},
): string | null {
  if (!claudeSessionId || claudeSessionId.includes('/')) return null
  const home = opts.home ?? os.homedir()
  const readdir = opts.readdir ?? ((dir: string) => fs.readdirSync(dir))
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file))
  const projects = path.join(home, '.claude', 'projects')
  let slugs: string[]
  try {
    slugs = readdir(projects)
  } catch {
    return null
  }
  const fileName = `${claudeSessionId}.jsonl`
  for (const slug of slugs) {
    const candidate = path.join(projects, slug, fileName)
    try {
      if (exists(candidate)) return candidate
    } catch {
      // Unreadable project dir — keep looking.
    }
  }
  return null
}
