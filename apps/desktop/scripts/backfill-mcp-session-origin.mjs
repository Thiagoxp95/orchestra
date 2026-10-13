#!/usr/bin/env node
// One-off backfill: mark sessions that agents opened through Orchestra's MCP
// server before sessions carried an `origin`, so they hide and stay silent too.
//
// Orchestra never recorded who opened a session, but the agents that called it
// did: every open_session / create_worktree / run_action result sits in their
// transcripts (Claude Code: ~/.claude/projects/**/*.jsonl, Codex:
// ~/.codex/sessions/**/*.jsonl). Any persisted session whose id one of those
// results returned gets origin 'mcp'. Nothing else is touched.
//
//   node scripts/backfill-mcp-session-origin.mjs           # dry run, lists matches
//   node scripts/backfill-mcp-session-origin.mjs --write   # quit Orchestra first
//
// Writing requires Orchestra to be quit: the running app holds the store in
// memory and would overwrite the file on its next save. A .bak copy is kept.

import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SPAWN_TOOLS = new Set(['open_session', 'create_worktree', 'run_action'])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const args = process.argv.slice(2)
const write = args.includes('--write')
const storeArg = args.find((a) => a.startsWith('--store='))
const storePath = storeArg
  ? storeArg.slice('--store='.length)
  : join(homedir(), 'Library/Application Support/@orchestra/desktop/orchestra-data.json')

function* jsonlFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsonlFiles(path)
    else if (entry.name.endsWith('.jsonl')) yield path
  }
}

/** Session ids returned by an Orchestra spawn tool, with the tool that returned them. */
function spawnedSessionIds() {
  const found = new Map()
  const note = (text, tool) => {
    for (const id of String(text).match(UUID) ?? []) if (!found.has(id)) found.set(id, tool)
  }
  for (const file of jsonlFiles(join(homedir(), '.claude/projects'))) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('orchestra__')) continue
    const pending = new Map() // tool_use id → tool name
    for (const line of text.split('\n')) {
      if (!line.includes('tool_')) continue
      let content
      try {
        content = JSON.parse(line).message?.content
      } catch {
        continue
      }
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part?.type === 'tool_use') {
          const tool = /orchestra__(\w+)$/.exec(part.name ?? '')?.[1]
          if (tool && SPAWN_TOOLS.has(tool)) pending.set(part.id, tool)
        } else if (part?.type === 'tool_result' && pending.has(part.tool_use_id)) {
          note(JSON.stringify(part.content), pending.get(part.tool_use_id))
          pending.delete(part.tool_use_id)
        }
      }
    }
  }
  for (const file of jsonlFiles(join(homedir(), '.codex/sessions'))) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('McpToolCall')) continue
    for (const line of text.split('\n')) {
      if (!line.includes('McpToolCall')) continue
      try {
        const item = JSON.parse(line).payload?.item
        if (item?.type === 'McpToolCall' && item.server === 'orchestra' && SPAWN_TOOLS.has(item.tool) && item.result) {
          note(JSON.stringify(item.result), item.tool)
        }
      } catch {
        // not a JSON line we understand
      }
    }
  }
  return found
}

function orchestraRunning() {
  try {
    execFileSync('pgrep', ['-x', 'Orchestra'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

statSync(storePath)
const store = JSON.parse(readFileSync(storePath, 'utf8'))
const sessions = store.data?.sessions ?? {}
const spawned = spawnedSessionIds()

const matches = Object.keys(sessions).filter((id) => spawned.has(id) && sessions[id].origin !== 'mcp')
console.log(`${spawned.size} session ids returned by Orchestra MCP spawn tools in agent transcripts`)
console.log(`${Object.keys(sessions).length} sessions in ${storePath}; ${matches.length} to mark as origin mcp:`)
for (const id of matches) {
  const s = sessions[id]
  console.log(`  ${id}  ${s.processStatus.padEnd(8)} ${spawned.get(id).padEnd(15)} ${(s.customLabel || s.label || '').slice(0, 60)}`)
}

if (!write || matches.length === 0) {
  if (!write && matches.length > 0) console.log('\nDry run. Quit Orchestra, then rerun with --write.')
  process.exit(0)
}
if (orchestraRunning()) {
  console.error('\nOrchestra is running and would overwrite this on its next save. Quit it, then rerun with --write.')
  process.exit(1)
}
copyFileSync(storePath, `${storePath}.bak-mcp-origin`)
for (const id of matches) sessions[id].origin = 'mcp'
writeFileSync(storePath, JSON.stringify(store, null, '\t'))
console.log(`\nMarked ${matches.length} sessions. Backup: ${storePath}.bak-mcp-origin`)
