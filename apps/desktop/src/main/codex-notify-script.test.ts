import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import {
  buildCodexNotifyScript,
  CODEX_NOTIFY_SCRIPT_MARKER,
  CODEX_NOTIFY_SCRIPT_NAME,
  ensureCodexNotifyScript,
  getCodexNotifyScriptPath,
} from './codex-notify-script'

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-notify-script-'))
}

describe('buildCodexNotifyScript', () => {
  it('starts with a bash shebang and the orchestra marker', () => {
    const script = buildCodexNotifyScript()
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/bash')
    expect(lines[1]).toBe(CODEX_NOTIFY_SCRIPT_MARKER)
  })

  it('passes bash -n syntax check', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-script-syntax-'))
    try {
      const file = path.join(tmp, 'codex-notify.sh')
      fs.writeFileSync(file, buildCodexNotifyScript(), { mode: 0o755 })
      // Throws on syntax errors.
      execSync(`bash -n ${JSON.stringify(file)}`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits when ORCHESTRA_CODEX_SESSION_ID is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-script-run-'))
    try {
      const file = path.join(tmp, 'codex-notify.sh')
      fs.writeFileSync(file, buildCodexNotifyScript(), { mode: 0o755 })
      // Empty env intentionally — the script should bail before any curl.
      const result = execSync(
        `bash ${JSON.stringify(file)} '{"hook_event_name":"Stop"}'`,
        { env: {} as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      expect(result.toString()).toBe('')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('only forwards SessionStart / UserPromptSubmit / Stop events', () => {
    const script = buildCodexNotifyScript()
    expect(script).toMatch(/SessionStart\|UserPromptSubmit\|Stop/)
  })

  it('includes a curl with both connect-timeout and max-time guards', () => {
    const script = buildCodexNotifyScript()
    expect(script).toMatch(/--connect-timeout 1/)
    expect(script).toMatch(/--max-time 2/)
    expect(script).toMatch(/127\.0\.0\.1:\$ORCHESTRA_CODEX_HOOK_PORT\/codex-hook/)
  })

  it('extracts session_id and transcript_path from the hook payload', () => {
    // The rollout watcher needs codex's session_id + transcript_path to attach
    // to the canonical JSONL. We forward both alongside the orchestra session
    // id so the listener can hand them off to the watcher.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-script-payload-'))
    try {
      // Stub curl so we capture the actual body the script would have POSTed.
      const fakeCurl = path.join(tmp, 'curl')
      const captureFile = path.join(tmp, 'captured-body')
      fs.writeFileSync(fakeCurl, `#!/bin/bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) printf '%s' "$2" > ${JSON.stringify(captureFile)}; shift 2 ;;
    *) shift ;;
  esac
done
exit 0
`, { mode: 0o755 })

      const script = path.join(tmp, 'codex-notify.sh')
      fs.writeFileSync(script, buildCodexNotifyScript(), { mode: 0o755 })

      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: '019e0307-f4cb-7413-8dbc-9896d5fbbf12',
        transcript_path: '/Users/tedy/.codex/sessions/2026/05/07/rollout-x.jsonl',
        cwd: '/some/cwd',
      })
      execSync(`bash ${JSON.stringify(script)} ${JSON.stringify(payload)}`, {
        env: {
          PATH: `${tmp}:${process.env.PATH}`,
          ORCHESTRA_CODEX_SESSION_ID: 'orch-1',
          ORCHESTRA_CODEX_HOOK_PORT: '12345',
        } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const captured = fs.readFileSync(captureFile, 'utf8')
      const parsed = JSON.parse(captured)
      expect(parsed).toEqual({
        sessionId: 'orch-1',
        event: 'SessionStart',
        codexSessionId: '019e0307-f4cb-7413-8dbc-9896d5fbbf12',
        transcriptPath: '/Users/tedy/.codex/sessions/2026/05/07/rollout-x.jsonl',
      })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('emits empty codexSessionId / transcriptPath when the payload omits them', () => {
    // The notify=[...] callback variant from codex CLI delivers a smaller
    // payload (just `type`). Forward what we have — the listener treats empty
    // strings as "no info available" and only attaches the watcher once a
    // hook with full info arrives.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-script-payload-min-'))
    try {
      const fakeCurl = path.join(tmp, 'curl')
      const captureFile = path.join(tmp, 'captured-body')
      fs.writeFileSync(fakeCurl, `#!/bin/bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) printf '%s' "$2" > ${JSON.stringify(captureFile)}; shift 2 ;;
    *) shift ;;
  esac
done
exit 0
`, { mode: 0o755 })

      const script = path.join(tmp, 'codex-notify.sh')
      fs.writeFileSync(script, buildCodexNotifyScript(), { mode: 0o755 })

      execSync(`bash ${JSON.stringify(script)} '{"type":"task_started"}'`, {
        env: {
          PATH: `${tmp}:${process.env.PATH}`,
          ORCHESTRA_CODEX_SESSION_ID: 'orch-1',
          ORCHESTRA_CODEX_HOOK_PORT: '12345',
        } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const captured = fs.readFileSync(captureFile, 'utf8')
      const parsed = JSON.parse(captured)
      expect(parsed.sessionId).toBe('orch-1')
      expect(parsed.event).toBe('UserPromptSubmit')
      expect(parsed.codexSessionId).toBe('')
      expect(parsed.transcriptPath).toBe('')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('ensureCodexNotifyScript', () => {
  let home: string
  let savedHome: string | undefined
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    home = makeTmpHome()
    savedHome = process.env.HOME
    savedNodeEnv = process.env.NODE_ENV
    process.env.HOME = home
    process.env.NODE_ENV = 'production' // keep ~/.orchestra (not -dev) for the test
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('writes the script with executable permissions', () => {
    const result = ensureCodexNotifyScript()
    const expected = path.join(home, '.orchestra', 'hooks', CODEX_NOTIFY_SCRIPT_NAME)
    expect(result.path).toBe(expected)
    expect(result.changed).toBe(true)
    expect(fs.existsSync(expected)).toBe(true)
    const stat = fs.statSync(expected)
    expect(stat.mode & 0o111).toBeTruthy()
  })

  it('is idempotent on repeat calls with identical content', () => {
    ensureCodexNotifyScript()
    const second = ensureCodexNotifyScript()
    expect(second.changed).toBe(false)
  })

  it('rewrites when the file diverges from the current template', () => {
    const file = getCodexNotifyScriptPath()
    ensureCodexNotifyScript()
    fs.writeFileSync(file, '# stale content\n', { mode: 0o755 })
    const result = ensureCodexNotifyScript()
    expect(result.changed).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(buildCodexNotifyScript())
  })
})
