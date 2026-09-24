import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorTerminalChatDir, exportAcpChatToTerminal, importTerminalChatToAcp } from './cursor-bridge'

const SQLITE = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
const roots: string[] = []
const ID = '89c7750a-9c2e-4950-96a4-ef410b10a7fd'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-bridge-')))
  roots.push(root)
  const home = join(root, 'cursor')
  const cwd = join(root, 'repo')
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd }
}

/** A store whose rows still sit in its WAL, like a Cursor agent that was just killed mid-session. */
function writeStore(dir: string, rows: string[], meta: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  const live = mkdtempSync(join(tmpdir(), 'cursor-live-'))
  const db = new DatabaseSync(join(live, 'store.db'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
  for (const row of rows) db.prepare("INSERT INTO blobs VALUES (?, x'00')").run(row)
  copyFileSync(join(live, 'store.db'), join(dir, 'store.db'))
  copyFileSync(join(live, 'store.db-wal'), join(dir, 'store.db-wal'))
  db.close()
  rmSync(live, { recursive: true, force: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
}

const rows = (dir: string) => execFileSync(SQLITE, [join(dir, 'store.db'), 'SELECT id FROM blobs ORDER BY id'], { encoding: 'utf8' }).trim().split('\n')
const meta = (dir: string) => JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const age = (dir: string, seconds: number) => {
  const time = new Date(Date.now() - seconds * 1_000)
  for (const name of ['store.db', 'store.db-wal']) if (existsSync(join(dir, name))) utimesSync(join(dir, name), time, time)
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('cursor bridge', () => {
  it('keys terminal chats by md5 of the real cwd', async () => {
    const { root, home, cwd } = fixture()
    symlinkSync(cwd, join(root, 'link'))
    const expected = join(home, 'chats', execFileSync('md5', ['-qs', cwd], { encoding: 'utf8' }).trim(), ID)
    await expect(cursorTerminalChatDir(ID, join(root, 'link'), home)).resolves.toBe(expected)
  })

  it('imports a terminal chat into acp-sessions with its WAL folded in, never touching the source', async () => {
    const { home, cwd } = fixture()
    const source = await cursorTerminalChatDir(ID, cwd, home)
    writeStore(source, ['a', 'b'], { schemaVersion: 1, createdAtMs: 1, hasConversation: true, updatedAtMs: 2, cwd, title: 'Codeword' })
    const sourceWal = statSync(join(source, 'store.db-wal')).size
    expect(sourceWal).toBeGreaterThan(0)

    await expect(importTerminalChatToAcp(ID, cwd, home)).resolves.toBe(true)
    const target = join(home, 'acp-sessions', ID)
    expect(readdirSync(target).sort()).toEqual(['meta.json', 'store.db'])
    expect(rows(target)).toEqual(['a', 'b'])
    expect(meta(target)).toEqual({ schemaVersion: 1, cwd, title: 'Codeword' })
    expect(statSync(join(source, 'store.db-wal')).size).toBe(sourceWal)
    // Stamped with the source's time: an unchanged conversation does not bounce back.
    await expect(importTerminalChatToAcp(ID, cwd, home)).resolves.toBe(false)
    await expect(exportAcpChatToTerminal(ID, cwd, home)).resolves.toBe(false)
  })

  it('exports a newer ACP session over an older terminal chat, keeping one backup', async () => {
    const { home, cwd } = fixture()
    const terminal = await cursorTerminalChatDir(ID, cwd, home)
    writeStore(terminal, ['old'], { schemaVersion: 1, createdAtMs: 5, hasConversation: true, updatedAtMs: 6, cwd })
    age(terminal, 60)
    const acp = join(home, 'acp-sessions', ID)
    writeStore(acp, ['new'], { schemaVersion: 1, cwd, title: 'Chat' })

    await expect(exportAcpChatToTerminal(ID, cwd, home)).resolves.toBe(true)
    expect(rows(terminal)).toEqual(['new'])
    expect(meta(terminal)).toMatchObject({ schemaVersion: 1, createdAtMs: 5, hasConversation: true, cwd, title: 'Chat' })
    // Backups stay out of chats/: Cursor would list a sibling directory as another chat.
    expect(readdirSync(join(terminal, '..'))).toEqual([ID])
    const backupDir = join(home, 'orchestra-bridge', relative(home, join(terminal, '..')))
    const backups = () => readdirSync(backupDir).filter((entry) => entry.startsWith(`${ID}.bak-`))
    expect(readdirSync(backupDir)).toEqual(backups())
    expect(backups()).toHaveLength(1)
    expect(rows(join(backupDir, backups()[0]!))).toEqual(['old'])

    execFileSync(SQLITE, [join(acp, 'store.db'), "INSERT INTO blobs VALUES ('newer', x'00')"])
    utimesSync(join(acp, 'store.db'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    await expect(exportAcpChatToTerminal(ID, cwd, home)).resolves.toBe(true)
    expect(rows(terminal)).toEqual(['new', 'newer'])
    expect(backups()).toHaveLength(1)
  })

  it('leaves a newer target alone and rejects ids that could escape the store', async () => {
    const { home, cwd } = fixture()
    const terminal = await cursorTerminalChatDir(ID, cwd, home)
    writeStore(terminal, ['stale'], { schemaVersion: 1, cwd })
    age(terminal, 60)
    writeStore(join(home, 'acp-sessions', ID), ['fresh'], { schemaVersion: 1, cwd, title: 'x' })
    await expect(importTerminalChatToAcp(ID, cwd, home)).resolves.toBe(false)
    expect(rows(join(home, 'acp-sessions', ID))).toEqual(['fresh'])
    await expect(importTerminalChatToAcp('missing-id', cwd, home)).resolves.toBe(false)
    await expect(importTerminalChatToAcp('../x', cwd, home)).rejects.toThrow(/Invalid Cursor chat id/)
  })
})
