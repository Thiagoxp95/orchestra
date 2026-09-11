import type { NativeChatRecord } from './manager'

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Provider transcripts stay on disk; the CLI reopens the exact SDK conversation. */
export function terminalConversationCommand(record: NativeChatRecord): string {
  const { provider, conversationId, settings } = record.snapshot
  if (!conversationId && record.history.length) throw new Error('Saved conversation id is missing; the original native history has been preserved')
  const args: string[] = [provider]
  if (conversationId) args.push(provider === 'claude' ? '--resume' : 'resume', quote(conversationId))
  if (settings.model) args.push('--model', quote(settings.model))
  if (settings.effort) args.push(...(provider === 'claude' ? ['--effort', quote(settings.effort)] : ['-c', quote(`model_reasoning_effort="${settings.effort}"`)]))
  if ((settings as typeof settings & { permissionMode?: string }).permissionMode === 'bypass') args.push(provider === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox')
  else args.push(...(provider === 'claude' ? ['--permission-mode', 'default'] : ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']))
  return args.join(' ')
}

type MigrationDependencies<T extends { isNew: boolean }> = {
  wasSuspended?(): Promise<boolean>
  attach(command?: string): Promise<T>
  idleShell(): Promise<boolean>
  write(data: string): Promise<void>
  save(record: NativeChatRecord): void
}
const pendingMigrations = new WeakMap<NativeChatRecord, Promise<unknown>>()
export function migrateTerminalConversation<T extends { isNew: boolean }>(record: NativeChatRecord, deps: MigrationDependencies<T>): Promise<T> {
  const existing = pendingMigrations.get(record)
  if (existing) return existing as Promise<T>
  const pending = performMigration(record, deps).finally(() => { pendingMigrations.delete(record) })
  pendingMigrations.set(record, pending)
  return pending
}
async function performMigration<T extends { isNew: boolean }>(record: NativeChatRecord, deps: MigrationDependencies<T>): Promise<T> {
  const command = terminalConversationCommand(record)
  const resumedSuspended = await deps.wasSuspended?.() ?? false
  if (resumedSuspended && record.terminalResumeInShell) {
    record.terminalResumePending = true
    deps.save(record)
  }
  const result = await deps.attach(command)
  if (result.isNew || !record.terminalMigrated || record.terminalResumePending) {
    // Existing agent/dev-server processes keep their terminal and running work.
    // Only the idle shell formerly parked underneath native chat gets a launch.
    if (!result.isNew && await deps.idleShell()) {
      await deps.write(`\x15cd -- ${quote(record.snapshot.cwd)} && ${command}\r`)
      record.terminalResumeInShell = true
    } else if (result.isNew) {
      record.terminalResumeInShell = false
    }
    record.terminalResumePending = false
    record.terminalMigrated = true
    deps.save(record)
  }
  return result
}

/** An exec'd TUI can occupy the shell PID with no children: verify the root command too. */
export function isIdleTerminalShell(pid: number, processTable: string): boolean {
  const rows = processTable.split('\n').map(line => line.trim().split(/\s+/))
  const root = rows.find(row => Number(row[0]) === pid)
  if (!root) return false
  const command = root.slice(2).join(' ').split('/').pop()?.replace(/^-/, '')
  return ['bash', 'zsh', 'sh', 'fish', 'ksh', 'dash'].includes(command ?? '')
    && !rows.some(row => Number(row[1]) === pid)
}
