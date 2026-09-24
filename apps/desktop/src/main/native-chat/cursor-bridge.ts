// Cursor keeps terminal chats and ACP (chat view) sessions in two stores that
// never see each other:
//   ~/.cursor/chats/<md5(realpath(cwd))>/<id>/   meta.json {schemaVersion,createdAtMs,hasConversation,updatedAtMs,cwd,title?}
//   ~/.cursor/acp-sessions/<id>/                 meta.json {schemaVersion,cwd,title}
// Both hold the same sqlite store.db (tables blobs+meta, agentId = <id>), so
// copying the store across is the handoff. Verified live against
// cursor-agent 2026.09.10 in both directions: session/load replays a copied
// terminal chat, and `agent --resume <id>` continues a copied ACP session.
//
// The newer store wins: a copy happens only when the target is missing or
// older, the copy is stamped with the source's mtime so an unchanged
// conversation never ping-pongs, and an overwritten target is kept as
// ~/.cursor/orchestra-bridge/<store path>/<id>.bak-<ts> (latest only). Staging
// and backups live OUTSIDE chats/ and acp-sessions/: Cursor lists every
// directory there as a session (a sibling <id>.bak-* showed up in session/list).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SQLITE = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
const DEFAULT_CURSOR_HOME = join(homedir(), '.cursor')

type Meta = Record<string, unknown>

/** Cursor keys the terminal store by md5 of the real path, no trailing slash (verified against symlinked cwds). */
export async function cursorTerminalChatDir(id: string, cwd: string, cursorHome = DEFAULT_CURSOR_HOME): Promise<string> {
  const real = await realpath(cwd)
  return join(cursorHome, 'chats', createHash('md5').update(real).digest('hex'), id)
}

async function storeMtime(dir: string): Promise<number | null> {
  const times = await Promise.all(['store.db', 'store.db-wal'].map((name) =>
    stat(join(dir, name)).then((info) => info.mtimeMs, () => null)))
  return times[0] === null ? null : Math.max(...times.filter((time): time is number => time !== null))
}

async function readMeta(dir: string): Promise<Meta> {
  try {
    const meta: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    return meta && typeof meta === 'object' ? meta as Meta : {}
  } catch {
    return {}
  }
}

async function copyStore(cursorHome: string, source: string, target: string, meta: (source: Meta, target: Meta) => Meta): Promise<boolean> {
  const sourceTime = await storeMtime(source)
  if (sourceTime === null) return false
  const targetTime = await storeMtime(target)
  // 1 s slack: utimes round-trips mtimes imprecisely, and a stamped copy must read as "same age".
  if (targetTime !== null && targetTime >= sourceTime - 1_000) return false
  const stamp = Date.now()
  const id = basename(target)
  const scratch = join(cursorHome, 'orchestra-bridge', relative(cursorHome, dirname(target)))
  const stage = join(scratch, `${id}.tmp-${stamp}`)
  await mkdir(stage, { recursive: true })
  await mkdir(dirname(target), { recursive: true })
  try {
    await copyFile(join(source, 'store.db'), join(stage, 'store.db'))
    // Fold the WAL into the COPY; the source store may belong to a running agent and is never opened.
    const wal = await copyFile(join(source, 'store.db-wal'), join(stage, 'store.db-wal')).then(() => true, () => false)
    if (wal) {
      await run(SQLITE, [join(stage, 'store.db'), 'PRAGMA wal_checkpoint(TRUNCATE);'])
      await rm(join(stage, 'store.db-wal'), { force: true })
      await rm(join(stage, 'store.db-shm'), { force: true })
    }
    await writeFile(join(stage, 'meta.json'), JSON.stringify(meta(await readMeta(source), await readMeta(target))))
    const time = new Date(sourceTime)
    await utimes(join(stage, 'store.db'), time, time)
    if (targetTime !== null || await stat(target).then(() => true, () => false)) {
      for (const entry of await readdir(scratch)) {
        if (entry.startsWith(`${id}.bak-`)) await rm(join(scratch, entry), { recursive: true, force: true })
      }
      await rename(target, join(scratch, `${id}.bak-${stamp}`))
    }
    await rename(stage, target)
    return true
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

function checkId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`Invalid Cursor chat id: ${id}`)
}

/** Terminal chat -> ACP session, so session/load can open a conversation the TUI started. */
export async function importTerminalChatToAcp(id: string, cwd: string, cursorHome = DEFAULT_CURSOR_HOME): Promise<boolean> {
  checkId(id)
  const real = await realpath(cwd)
  return copyStore(cursorHome, await cursorTerminalChatDir(id, real, cursorHome), join(cursorHome, 'acp-sessions', id), (source, target) => ({
    schemaVersion: 1,
    cwd: real,
    title: source.title ?? target.title ?? 'Cursor chat',
  }))
}

/** ACP session -> terminal chat, so `agent --resume <id>` continues a conversation the chat view had. */
export async function exportAcpChatToTerminal(id: string, cwd: string, cursorHome = DEFAULT_CURSOR_HOME): Promise<boolean> {
  checkId(id)
  const real = await realpath(cwd)
  const now = Date.now()
  return copyStore(cursorHome, join(cursorHome, 'acp-sessions', id), await cursorTerminalChatDir(id, real, cursorHome), (source, target) => ({
    schemaVersion: 1,
    createdAtMs: typeof target.createdAtMs === 'number' ? target.createdAtMs : now,
    hasConversation: true,
    updatedAtMs: now,
    cwd: real,
    ...(typeof (source.title ?? target.title) === 'string' ? { title: source.title ?? target.title } : {}),
  }))
}
