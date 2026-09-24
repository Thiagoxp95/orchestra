import { describe, expect, it } from 'vitest'
import { terminalConversationCommand, migrateTerminalConversation } from './terminal-migration'
import type { NativeChatRecord } from './manager'
const record = (extra = {}): NativeChatRecord => ({ snapshot: { sessionId: 'pane', provider: 'claude', cwd: '/repo', conversationId: '12345678-abcd-abcd-abcd-123456789012', settings: { model: 'opus', effort: 'high', permissionMode: 'default' as const }, view: 'terminal', status: 'stopped', requests: [], revision: 1 }, history: [], receipts: [], ...extra })
describe('terminal conversation handoff', () => {
  it('resumes the same provider conversation and retains explicit permission settings', () => {
    const command = terminalConversationCommand(record())
    expect(command).toContain("claude --resume '12345678-abcd-abcd-abcd-123456789012'")
    expect(command).toContain("--model 'opus' --effort 'high'")
    expect(command).not.toContain('dangerously')
  })
  it('retains provider permission defaults for existing native records', () => {
    const saved = record(); saved.snapshot.settings = { model: 'opus' }
    expect(terminalConversationCommand(saved)).not.toContain('dangerously')
  })
  it('refuses to silently replace a saved conversation with no provider id', () => {
    const saved = record(); saved.snapshot.conversationId = undefined; saved.history = [{ uid: 'message' } as never]
    expect(() => terminalConversationCommand(saved)).toThrow('conversation id')
  })
  it('launches a saved conversation in its existing idle shell once, keeping the PTY', async () => {
    const saved = record(); const writes: string[] = []; const launches: unknown[] = []
    const attach = async (command?: string) => { launches.push(command); return { isNew: false } }
    await migrateTerminalConversation(saved, { attach, idleShell: async () => true, write: async data => { writes.push(data) }, save: () => {} })
    await migrateTerminalConversation(saved, { attach, idleShell: async () => true, write: async data => { writes.push(data) }, save: () => {} })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('claude --resume')
    expect(launches).toHaveLength(2)
  })
  it('preserves an active CLI and marks the old native owner retired', async () => {
    const saved = record(); let writes = 0
    await migrateTerminalConversation(saved, { attach: async () => ({ isNew: false }), idleShell: async () => false, write: async () => { writes++ }, save: () => {} })
    expect(writes).toBe(0)
    expect(saved.terminalMigrated).toBe(true)
  })
})

it('coalesces simultaneous attaches into one resume write', async () => {
  const saved = record(); let writes = 0; let attaches = 0
  const deps = { attach: async () => { attaches++; return { isNew: false } }, idleShell: async () => true, write: async () => { writes++ }, save: () => {} }
  await Promise.all([migrateTerminalConversation(saved, deps), migrateTerminalConversation(saved, deps)])
  expect(writes).toBe(1)
  expect(attaches).toBe(1)
})
it('recognizes only an idle shell as safe for an in-place resume', async () => {
  const { isIdleTerminalShell } = await import('./terminal-migration')
  expect(isIdleTerminalShell(42, '42 1 /bin/zsh\n')).toBe(true)
  expect(isIdleTerminalShell(42, '42 1 /bin/zsh\n43 42 codex\n')).toBe(false)
  expect(isIdleTerminalShell(42, '42 1 /usr/local/bin/codex\n')).toBe(false)
  expect(isIdleTerminalShell(42, '42 1 vim\n')).toBe(false)
  expect(isIdleTerminalShell(42, '')).toBe(false)
})

it('pins archived SDK permissions rather than inheriting CLI config', () => {
  const saved = record(); saved.snapshot.settings = {}
  expect(terminalConversationCommand(saved)).toContain('--permission-mode default')
  saved.snapshot.provider = 'codex'
  expect(terminalConversationCommand(saved)).toContain('--ask-for-approval on-request --sandbox workspace-write')
})

it('resumes a previously migrated suspended shell once without restarting a live PTY', async () => {
  const saved = record({ terminalMigrated: true, terminalResumeInShell: true }); let suspended = true; let writes = 0
  const deps = {
    wasSuspended: async () => suspended,
    attach: async () => { suspended = false; return { isNew: false } },
    idleShell: async () => true,
    write: async () => { writes++ }, save: () => {},
  }
  await Promise.all([migrateTerminalConversation(saved, deps), migrateTerminalConversation(saved, deps)])
  await migrateTerminalConversation(saved, deps)
  expect(writes).toBe(1)
})

it('does not inject a second launch when the daemon already owns the startup command', async () => {
  const saved = record({ terminalMigrated: true }); let writes = 0
  await migrateTerminalConversation(saved, { wasSuspended: async () => true, attach: async () => ({ isNew: false }), idleShell: async () => true, write: async () => { writes++ }, save: () => {} })
  expect(writes).toBe(0)
})

it('clears the in-place marker when a cold daemon creates a replacement CLI terminal', async () => {
  const saved = record({ terminalMigrated: true, terminalResumeInShell: true })
  const persisted: NativeChatRecord[] = []
  await migrateTerminalConversation(saved, {
    attach: async () => ({ isNew: true }), idleShell: async () => true,
    write: async () => {}, save: value => { persisted.push(structuredClone(value)) },
  })
  expect(saved.terminalResumeInShell).toBe(false)
  expect(persisted.at(-1)?.terminalResumeInShell).toBe(false)
})
