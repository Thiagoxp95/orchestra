// Names sessions after what they are doing. Each prompt sent to an agent goes
// through a one-shot `claude -p` on Haiku at low effort (the user's Claude
// subscription, no API key), along with the session's current title, so the
// title keeps rolling with the work instead of echoing the raw prompt.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildShellChildEnv } from './node-runtime'
import { shouldSummarizePrompt } from './prompt-summarizer'

const TITLE_TIMEOUT_MS = 30_000
const MAX_PROMPT_CHARS = 2000
const MAX_TITLE_CHARS = 60
const MAX_TITLE_WORDS = 7

const SYSTEM_PROMPT =
  'You name coding-agent sessions in a sidebar. Reply with ONLY a 2-5 word title: an -ing verb ' +
  'plus the concrete thing being worked on, specific enough to tell this session apart at a glance. ' +
  "Examples: 'Optimizing keyboard layout', 'Fixing Fold standby display', 'Shipping session titles'. " +
  'If the latest message continues the same work (a reply, a yes, a follow-up), return the current ' +
  'title unchanged. No quotes, no trailing punctuation, no explanation.'

// Shell-quoted for `sh -c`; the prompt itself goes over stdin.
const CLAUDE_ARGS = [
  '-p', '--model', 'haiku', '--effort', 'low',
  // No tools, MCP servers, hooks (orchestra's own live in ~/.claude/settings.json),
  // or transcript: this run must not show up as a session of its own anywhere.
  '--tools', "''", '--strict-mcp-config', '--setting-sources', "''", '--no-session-persistence',
  '--system-prompt', `'${SYSTEM_PROMPT.replace(/'/g, `'\\''`)}'`,
].join(' ')

const titles = new Map<string, string>()
const generations = new Map<string, number>()

/** Clean a model reply into a sidebar title, or '' when it isn't one. */
export function sanitizeTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const title = line
    .replace(/^title:\s*/i, '')
    .replace(/^["'`*]+|["'`*]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim()
  if (!title || title.length > MAX_TITLE_CHARS) return ''
  if (title.split(/\s+/).length > MAX_TITLE_WORDS) return ''
  return title
}

export function buildTitleRequest(prompt: string, currentTitle: string | undefined): string {
  return `Current title: ${currentTitle || '(none yet)'}\nLatest user message:\n${prompt.slice(0, MAX_PROMPT_CHARS)}`
}

function runClaude(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/sh'
    // An empty cwd: the packaged app runs from `/`, and claude scanning the
    // whole disk from there blows past the timeout.
    const cwd = join(tmpdir(), 'orchestra-session-titler')
    mkdirSync(cwd, { recursive: true })
    const child = spawn(shell, ['-l', '-c', `exec claude ${CLAUDE_ARGS}`], {
      cwd,
      env: buildShellChildEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), TITLE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`claude -p exited ${code}`))
    })
    child.stdin.end(input)
  })
}

/**
 * Title a session from its latest prompt. `apply` gets the raw prompt right away
 * when the session has no generated title yet (so it is never unnamed), then the
 * generated title. A short follow-up ("yes", "install") keeps the current title.
 * Only the newest prompt per session may apply; a slow older reply is dropped.
 */
export function titleSessionFromPrompt(sessionId: string, prompt: string, apply: (label: string) => void): void {
  const current = titles.get(sessionId)
  if (!current) apply(prompt)
  if (!shouldSummarizePrompt(prompt)) return

  const generation = (generations.get(sessionId) ?? 0) + 1
  generations.set(sessionId, generation)
  runClaude(buildTitleRequest(prompt, current))
    .then((raw) => {
      if (generations.get(sessionId) !== generation) return
      const title = sanitizeTitle(raw)
      if (!title) return
      titles.set(sessionId, title)
      apply(title)
    })
    .catch((err) => {
      // Keep whatever the session is called now: a missing or logged-out claude
      // means it never got a title, so it is still showing the raw prompt.
      console.warn('[session-titler] claude -p failed:', err instanceof Error ? err.message : err)
    })
}
