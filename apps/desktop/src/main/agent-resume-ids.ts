// Which conversation would this session resume?
//
// Every agent CLI can be told to reopen a past conversation by id — `claude
// --resume <id>`, `codex resume <id>`, `agent --resume <chatId>` — and every one
// of them writes that id into a path on disk. This module is the translation
// between the two, so a session row that outlived its process (the machine
// rebooted, the daemon died) can offer to bring its own conversation back rather
// than making the person hunt for it in the resume sheet.
//
//   Claude: ~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
//   Cursor: ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db
//           …with a readable transcript alongside it at
//           ~/.cursor/projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl
//
// Claude and Codex are already resolved to a transcript path by the context
// tracker, so for those two this is pure path parsing. Cursor has no transcript
// tracking at all (it writes SQLite, not JSONL), so its lookup lives here too —
// the chats directory is keyed by an md5 of the working directory, which makes
// "the newest cursor chat in this folder" a directory listing rather than a
// search.
//
// Kept free of Electron so it can be unit-tested like the rest of main/.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ResumableAgent } from '../shared/types'

export type { ResumableAgent }
export { isResumableAgent } from '../shared/action-utils'

/** A v4 UUID, which is what all three CLIs use for conversation ids. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * The conversation id a transcript path belongs to.
 *
 * Codex names its rollouts `rollout-<ISO timestamp>-<uuid>.jsonl`, and the
 * timestamp itself contains dashes, so the id is matched rather than split off.
 * Claude and Cursor both name the file after the id outright.
 *
 * Returns null for anything that doesn't look like a conversation id — a
 * half-written filename, a path from a future format — because a wrong id would
 * resume the wrong conversation, which is worse than offering no button.
 */
export function agentSessionIdFromTranscript(agent: ResumableAgent, filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.jsonl$/, '')
  if (agent === 'codex') {
    const match = base.match(new RegExp(`(${UUID.source})$`))
    return match ? match[1] : null
  }
  return UUID.test(base) && base.length === 36 ? base : null
}

/**
 * Cursor's per-workspace chat directory: `~/.cursor/chats/<md5 of the workspace
 * path>`. The hash is over the path exactly as cursor was launched with it, with
 * no trailing slash.
 */
export function cursorChatsDir(cwd: string, home: string): string {
  const key = cwd.replace(/\/+$/, '')
  return path.join(home, '.cursor', 'chats', createHash('md5').update(key).digest('hex'))
}

export interface CursorChat {
  chatId: string
  /** Last write to the chat's store, i.e. when it was last used. */
  updatedAt: number
}

/**
 * Every cursor chat recorded for a directory, newest first.
 *
 * Recency comes from the chat's own SQLite store rather than the directory,
 * because the directory's mtime only moves when a file is added to it — a long
 * conversation would look as old as its first message.
 */
export function listCursorChats(cwd: string, home: string, fsImpl: typeof fs = fs): CursorChat[] {
  const dir = cursorChatsDir(cwd, home)
  let names: string[]
  try {
    names = fsImpl.readdirSync(dir)
  } catch {
    return []
  }
  const chats: CursorChat[] = []
  for (const name of names) {
    if (!UUID.test(name) || name.length !== 36) continue
    let updatedAt = 0
    // -wal holds the newest writes until a checkpoint, so the store alone can
    // read as stale for a chat that is actively in use.
    for (const file of ['store.db-wal', 'store.db']) {
      try {
        updatedAt = Math.max(updatedAt, fsImpl.statSync(path.join(dir, name, file)).mtimeMs)
      } catch {}
    }
    if (updatedAt > 0) chats.push({ chatId: name, updatedAt: Math.round(updatedAt) })
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The cursor chat a session in this directory would resume: the newest one,
 * excluding any another session has already claimed.
 *
 * The exclusion set is the same defence the claude fallback uses — two cursor
 * panes in one worktree must not both offer to resume the same conversation.
 */
export function findCursorChat(
  cwd: string,
  home: string,
  claimedChatIds: readonly string[] = [],
  fsImpl: typeof fs = fs,
): CursorChat | null {
  const claimed = new Set(claimedChatIds)
  return listCursorChats(cwd, home, fsImpl).find((chat) => !claimed.has(chat.chatId)) ?? null
}

/**
 * The readable transcript for a cursor chat, if one was written.
 *
 * Cursor keys these by a slug of the workspace path that it truncates and
 * hashes for long paths, so the directory can't be derived the way claude's can
 * — it's found by looking for the chat id under each project instead. Only used
 * for a title, so a miss is harmless.
 */
export function findCursorTranscript(chatId: string, home: string, fsImpl: typeof fs = fs): string | null {
  const projects = path.join(home, '.cursor', 'projects')
  let slugs: string[]
  try {
    slugs = fsImpl.readdirSync(projects)
  } catch {
    return null
  }
  for (const slug of slugs) {
    const file = path.join(projects, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`)
    try {
      if (fsImpl.statSync(file).size > 0) return file
    } catch {}
  }
  return null
}
