import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildCodexHooksJsonContent,
  ensureCodexHooksRegistered,
  getCodexGlobalHooksPath,
  removeLegacyCodexArtifacts,
} from './codex-hooks-setup'

const LEGACY_WRAPPER_BODY = `#!/bin/bash
# Orchestra Codex wrapper
exec "$@"
`

const NOTIFY = '/tmp/orch-test-notify.sh'

describe('buildCodexHooksJsonContent', () => {
  it('returns null when the existing file was unparseable', () => {
    expect(buildCodexHooksJsonContent(null, NOTIFY)).toBeNull()
  })

  it('produces UserPromptSubmit + Stop entries in an empty file', () => {
    const content = buildCodexHooksJsonContent({}, NOTIFY)
    expect(content).not.toBeNull()
    const parsed = JSON.parse(content!)
    expect(parsed.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: NOTIFY }] },
    ])
    expect(parsed.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: NOTIFY }] },
    ])
  })

  it('preserves user-defined hooks alongside our managed entry', () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/custom/user-hook.sh' }] },
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/custom/stop.sh' }] },
        ],
      },
    }
    const content = buildCodexHooksJsonContent(existing, NOTIFY)
    const parsed = JSON.parse(content!)

    const userPromptCmds = (parsed.hooks.UserPromptSubmit as any[])
      .flatMap((def: any) => def.hooks.map((h: any) => h.command))
    expect(userPromptCmds).toContain('/custom/user-hook.sh')
    expect(userPromptCmds).toContain(NOTIFY)

    const stopCmds = (parsed.hooks.Stop as any[])
      .flatMap((def: any) => def.hooks.map((h: any) => h.command))
    expect(stopCmds).toContain('/custom/stop.sh')
    expect(stopCmds).toContain(NOTIFY)
  })

  it('replaces a stale managed entry rather than duplicating it', () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: NOTIFY }] }],
      },
    }
    const content = buildCodexHooksJsonContent(existing, NOTIFY)
    const parsed = JSON.parse(content!)
    expect(parsed.hooks.Stop).toHaveLength(1)
  })

  it('strips stale managed entries from events we no longer manage', () => {
    const existing = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: NOTIFY }] }],
        Stop: [],
      },
    }
    const content = buildCodexHooksJsonContent(existing, NOTIFY)
    const parsed = JSON.parse(content!)
    expect(parsed.hooks.SessionStart).toBeUndefined()
  })

  it('matches managed entries by script basename across home roots', () => {
    const stalePath = '/old/.orchestra/hooks/codex-notify.sh'
    const newPath = '/new/.orchestra/hooks/codex-notify.sh'
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: stalePath }] }],
      },
    }
    const content = buildCodexHooksJsonContent(existing, newPath)
    const parsed = JSON.parse(content!)
    const stopCmds = (parsed.hooks.Stop as any[])
      .flatMap((def: any) => def.hooks.map((h: any) => h.command))
    expect(stopCmds).toEqual([newPath])
  })

  it('preserves unrelated top-level keys', () => {
    const existing = { somethingElse: { foo: 'bar' } } as Record<string, unknown>
    const content = buildCodexHooksJsonContent(existing as any, NOTIFY)
    const parsed = JSON.parse(content!)
    expect(parsed.somethingElse).toEqual({ foo: 'bar' })
  })
})

describe('ensureCodexHooksRegistered', () => {
  let tmpHome: string
  let savedHome: string | undefined
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hooks-setup-'))
    savedHome = process.env.HOME
    savedNodeEnv = process.env.NODE_ENV
    process.env.HOME = tmpHome
    process.env.NODE_ENV = 'production'
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates ~/.codex/hooks.json with managed events when missing', () => {
    const result = ensureCodexHooksRegistered({ home: tmpHome })
    expect(result).not.toBeNull()
    const hooksPath = getCodexGlobalHooksPath(tmpHome)
    expect(fs.existsSync(hooksPath)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'))
    expect(parsed.hooks.UserPromptSubmit).toBeDefined()
    expect(parsed.hooks.Stop).toBeDefined()
    expect(result!.scriptChanged).toBe(true)
    expect(result!.hooksChanged).toBe(true)
  })

  it('does not rewrite when content is unchanged', () => {
    ensureCodexHooksRegistered({ home: tmpHome })
    const second = ensureCodexHooksRegistered({ home: tmpHome })
    expect(second).not.toBeNull()
    expect(second!.hooksChanged).toBe(false)
    expect(second!.scriptChanged).toBe(false)
  })

  it('refuses to clobber an unparseable hooks.json', () => {
    const hooksPath = getCodexGlobalHooksPath(tmpHome)
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true })
    fs.writeFileSync(hooksPath, 'not valid json {[')
    const result = ensureCodexHooksRegistered({ home: tmpHome })
    expect(result).toBeNull()
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe('not valid json {[')
  })
})

describe('removeLegacyCodexArtifacts', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-legacy-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('removes wrapper files matching the legacy signature', () => {
    const wrapper = path.join(tmpHome, '.orchestra', 'bin', 'codex')
    fs.mkdirSync(path.dirname(wrapper), { recursive: true })
    fs.writeFileSync(wrapper, LEGACY_WRAPPER_BODY)
    const removed = removeLegacyCodexArtifacts(tmpHome)
    expect(removed).toContain(wrapper)
    expect(fs.existsSync(wrapper)).toBe(false)
  })

  it('removes wrappers from both prod and dev orchestra paths', () => {
    const prod = path.join(tmpHome, '.orchestra', 'bin', 'codex')
    const dev = path.join(tmpHome, '.orchestra-dev', 'bin', 'codex')
    fs.mkdirSync(path.dirname(prod), { recursive: true })
    fs.mkdirSync(path.dirname(dev), { recursive: true })
    fs.writeFileSync(prod, LEGACY_WRAPPER_BODY)
    fs.writeFileSync(dev, LEGACY_WRAPPER_BODY)
    const removed = removeLegacyCodexArtifacts(tmpHome)
    expect(removed).toContain(prod)
    expect(removed).toContain(dev)
  })

  it('leaves a wrapper alone when it does not match the signature', () => {
    const wrapper = path.join(tmpHome, '.orchestra', 'bin', 'codex')
    fs.mkdirSync(path.dirname(wrapper), { recursive: true })
    fs.writeFileSync(wrapper, '#!/bin/bash\nexec /opt/codex "$@"\n')
    const removed = removeLegacyCodexArtifacts(tmpHome)
    expect(removed).toEqual([])
    expect(fs.existsSync(wrapper)).toBe(true)
  })

  it('removes orphan codex-sessions directories under both home roots', () => {
    const prod = path.join(tmpHome, '.orchestra', 'hooks', 'codex-sessions')
    const dev = path.join(tmpHome, '.orchestra-dev', 'hooks', 'codex-sessions')
    fs.mkdirSync(prod, { recursive: true })
    fs.mkdirSync(dev, { recursive: true })
    fs.writeFileSync(path.join(prod, 'session-1.jsonl'), '{}\n')
    const removed = removeLegacyCodexArtifacts(tmpHome)
    expect(removed).toContain(prod)
    expect(removed).toContain(dev)
    expect(fs.existsSync(prod)).toBe(false)
    expect(fs.existsSync(dev)).toBe(false)
  })

  it('is a no-op when nothing legacy is present', () => {
    expect(removeLegacyCodexArtifacts(tmpHome)).toEqual([])
  })
})
