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
