// src/main/local-server/mcp.ts
//
// An MCP server (streamable HTTP, stateless JSON responses) at POST /mcp, so
// other agents can drive Orchestra the way the phone does: read the workspace
// and session state; create, update and delete workspaces, worktrees, sessions
// and actions; focus things on the desktop; and read from / type into any terminal.
//
// Every mutation goes through sendRemoteCommand — the phone's own serialized
// command path — so an agent can do exactly what the phone can and nothing the
// bridge hasn't already vetted. Loopback only: index.ts refuses requests that
// arrived through Tailscale Serve or carry a foreign Host/Origin.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { Terminal } from '@xterm/headless'
import { getDaemonClient } from '../daemon-client'
import { loadPersistedData } from '../persistence'
import type { MirroredUpdate } from '../remote-bridge-update'
import { hasRecentTerminalOutput } from '../terminal-output-buffer'
import { sendRemoteCommand } from './api'
import { getRemoteState } from './runtime-state'

type Json = Record<string, any>
type Tool = {
  name: string
  description: string
  inputSchema: Json
  annotations?: Json
  run: (args: Json) => Promise<unknown>
}

const AGENTS = ['terminal', 'claude', 'codex', 'cursor']
const ACTION_TYPES = ['cli', 'claude', 'codex', 'cursor']

const KEYS: Record<string, string> = {
  enter: '\r', tab: '\t', 'shift-tab': '\x1b[Z', escape: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
}

function keyBytes(name: string): string {
  const key = name.trim().toLowerCase()
  if (KEYS[key]) return KEYS[key]
  const ctrl = key.match(/^ctrl-([a-z])$/)
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96)
  throw new Error(`Unknown key "${name}". Use ${Object.keys(KEYS).join(', ')} or ctrl-<letter>.`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until the session has been silent for `quietMs`, or `capMs` passes. */
async function settle(sessionId: string, quietMs = 250, capMs = 4_000): Promise<void> {
  for (let waited = 0; waited < capMs && hasRecentTerminalOutput(sessionId, quietMs); waited += 50) await sleep(50)
}

/** Poll `probe` until it returns something, or give up with null. */
async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(200)) {
    const value = probe()
    if (value != null) return value
  }
  return probe() ?? null
}

function mirror(): { workspaces: any[]; sessions: Record<string, any>; liveStatus: Record<string, any>; activeWorkspaceId: string | null; activeSessionId: string | null; updateStatus?: MirroredUpdate } {
  const state = getRemoteState()
  if (!state) throw new Error('Orchestra has not published its state yet')
  return state as any
}

function workspace(id: unknown): any {
  const ws = mirror().workspaces.find((w) => w.id === id)
  if (!ws) throw new Error(`Unknown workspaceId "${id}". Call get_state for the list.`)
  return ws
}

/** The workspace whose main checkout is `rootDir`, if one is registered. */
function workspaceAt(rootDir: string): any {
  return mirror().workspaces.find((w) => w.trees[0] && resolve(w.trees[0].rootDir) === rootDir)
}

function requireTree(ws: any, treeIndex: unknown): number {
  if (!Number.isInteger(treeIndex) || !ws.trees[treeIndex as number]) throw new Error(`No tree ${treeIndex} in ${ws.name}`)
  return treeIndex as number
}

function requireAction(ws: any, actionId: unknown): string {
  if (!ws.customActions.some((a: any) => a.id === actionId)) throw new Error(`Unknown actionId "${actionId}" in ${ws.name}`)
  return actionId as string
}

/** The action fields an MCP client may set, validated; undefined ones are left out. */
function actionFields(args: Json): Json {
  const out: Json = {}
  for (const key of ['name', 'command', 'icon', 'keybinding'] as const) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'string') throw new Error(`${key} must be a string`)
    out[key] = args[key]
  }
  for (const key of ['runOnWorktreeCreation', 'runOnWorktreeDestruction', 'runInBackground'] as const) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    out[key] = args[key]
  }
  if (args.actionType !== undefined) {
    if (!ACTION_TYPES.includes(args.actionType)) throw new Error(`actionType must be one of ${ACTION_TYPES.join(', ')}`)
    out.actionType = args.actionType
  }
  return out
}

function requireSession(id: unknown): string {
  if (typeof id !== 'string' || !(id in mirror().sessions)) {
    throw new Error(`Unknown sessionId "${id}". Call get_state for the list.`)
  }
  return id
}

function treeSessionIds(workspaceId: string, treeIndex: number): string[] {
  return workspace(workspaceId).trees[treeIndex]?.sessionIds ?? []
}

/** The first session in the tree that wasn't there before, once it mirrors back. */
function awaitNewSession(workspaceId: string, treeIndex: number, before: string[], timeoutMs: number) {
  return waitFor(() => treeSessionIds(workspaceId, treeIndex).find((id) => !before.includes(id)), timeoutMs)
}

/**
 * The session create_worktree spun up. A new tree opens with its own default
 * terminal (index 0, never started until focused), then the creation actions,
 * then the spin-up — so it is the last session of that type after the first.
 */
function spunUpSession(workspaceId: string, treeIndex: number, agent: string): string | undefined {
  const { sessions } = mirror()
  return treeSessionIds(workspaceId, treeIndex).slice(1).reverse().find((id) => sessions[id]?.processStatus === agent)
}

function getState(): unknown {
  const { workspaces, sessions, liveStatus, activeWorkspaceId, activeSessionId } = mirror()
  // Actions with their commands come from the store (the mirror only carries names).
  const persisted = loadPersistedData().workspaces
  return {
    activeWorkspaceId,
    activeSessionId,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      color: w.color,
      emoji: w.emoji,
      activeTreeIndex: w.activeTreeIndex,
      trees: w.trees.map((t: any, index: number) => ({
        index,
        branch: t.branch ?? null,
        ...(t.displayName ? { displayName: t.displayName } : {}),
        rootDir: t.rootDir,
        pr: t.pr ? { number: t.pr.number, state: t.pr.state, url: t.pr.url } : undefined,
        sessions: t.sessionIds.filter((id: string) => sessions[id]).map((id: string) => ({
          id,
          label: sessions[id].customLabel || liveStatus[id]?.label || sessions[id].label,
          type: sessions[id].processStatus,
          work: liveStatus[id]?.work ?? 'idle',
          attention: liveStatus[id]?.attention,
          exited: liveStatus[id]?.exited || undefined,
          pinned: sessions[id].pinned || undefined,
          origin: sessions[id].origin ?? 'user',
        })),
      })),
      actions: (persisted[w.id]?.customActions ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.actionType ?? 'cli',
        command: a.command,
        ...(a.runOnWorktreeCreation ? { runOnWorktreeCreation: true } : {}),
        ...(a.runInBackground ? { background: true } : {}),
      })),
    })),
  }
}

function updateStatus(): MirroredUpdate {
  const update = mirror().updateStatus
  if (!update) throw new Error('Orchestra has not published its update status yet')
  return update
}

/** Screen + scrollback as plain text, rendered through a headless xterm. */
async function readTerminal(sessionId: string, lines: number): Promise<string> {
  const snap = await getDaemonClient().getSnapshot(sessionId)
  if (!snap) throw new Error(`No live terminal for session ${sessionId}`)
  const term = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 10_000, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) => term.write(snap.snapshotAnsi, resolve))
    const buffer = term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '')
    while (out.length && !out[out.length - 1].trim()) out.pop()
    return out.slice(-lines).join('\n')
  } finally {
    term.dispose()
  }
}

const str = { type: 'string' }
const int = { type: 'integer', minimum: 0 }

const ACTION_PROPS = {
  name: str,
  command: { ...str, description: 'Shell command for cli actions; for claude/codex/cursor, the prompt or extra args ("" opens the agent).' },
  actionType: { enum: ACTION_TYPES },
  icon: { ...str, description: "A hugeicons name, or __terminal__ / __claude__ / __openai__ / __cursor__." },
  keybinding: { ...str, description: 'e.g. Cmd+K; "" for none.' },
  runOnWorktreeCreation: { type: 'boolean' },
  runOnWorktreeDestruction: { type: 'boolean' },
  runInBackground: { type: 'boolean' },
}

const TOOLS: Tool[] = [
  {
    name: 'get_state',
    description:
      'Everything Orchestra shows: workspaces, their trees (index 0 = main checkout, others = git worktrees) with branch/PR, ' +
      'the sessions in each tree (type terminal/claude/codex/cursor, work idle|working, attention when waiting on the user), ' +
      "each workspace's custom actions with their commands, and what is focused. A process running inside Orchestra finds " +
      "its own session id in $ORCHESTRA_SESSION_ID. origin 'mcp' marks sessions opened through this server.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => getState(),
  },
  {
    name: 'focus',
    description: 'Switch the desktop to a session (its workspace and tree follow), or to a workspace and optionally one of its trees.',
    inputSchema: { type: 'object', properties: { sessionId: str, workspaceId: str, treeIndex: int } },
    run: async ({ sessionId, workspaceId, treeIndex }) => {
      if (sessionId) await sendRemoteCommand('focus', requireSession(sessionId))
      else await sendRemoteCommand('focus', '', { workspaceId: workspace(workspaceId).id, treeIndex })
      return 'ok'
    },
  },
  {
    name: 'create_worktree',
    description:
      'Create a git worktree on a new branch in a workspace, running the chosen actions and optionally spinning up an agent in it. ' +
      'Waits up to 60s for the tree to appear and returns its index, the spun-up sessionId and all its sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: str,
        branch: str,
        actionIds: { type: 'array', items: str, description: 'Custom action ids to run in the new tree (see get_state).' },
        spinUp: { enum: AGENTS },
      },
      required: ['workspaceId', 'branch'],
    },
    run: async ({ workspaceId, branch, actionIds, spinUp }) => {
      const ws = workspace(workspaceId)
      if (typeof branch !== 'string' || !branch.trim()) throw new Error('branch is required')
      const before = ws.trees.length
      await sendRemoteCommand('createWorktree', '', {
        workspaceId: ws.id, branch, selectedActionIds: actionIds ?? [], spinUp: spinUp ?? null, origin: 'mcp',
      })
      const index = await waitFor(() => {
        const trees = workspace(ws.id).trees
        return trees.length > before ? trees.length - 1 : null
      }, 60_000)
      if (index === null) return 'Requested; the worktree has not appeared yet — check get_state.'
      if (!spinUp) return { treeIndex: index, sessionIds: treeSessionIds(ws.id, index) }
      const sessionId = await waitFor(() => spunUpSession(ws.id, index, spinUp), 10_000)
      return { treeIndex: index, ...(sessionId ? { sessionId } : {}), sessionIds: treeSessionIds(ws.id, index) }
    },
  },
  {
    name: 'create_workspace',
    description:
      'Create a workspace: makes the folder (default ~/Pessoal/<name>), `git init`s it unless it is already a repo (no commits), ' +
      "and registers it like the desktop's New Workspace dialog (default actions, first terminal, focused). " +
      'A folder that is already a workspace returns its existing workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str,
        rootDir: { ...str, description: 'Absolute path or ~/…; defaults to ~/Pessoal/<name>.' },
        gitInit: { type: 'boolean', default: true },
      },
      required: ['name'],
    },
    run: async ({ name, rootDir, gitInit }) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name is required')
      const label = name.trim()
      const raw = typeof rootDir === 'string' && rootDir.trim() ? rootDir.trim() : join('~', 'Pessoal', label)
      const dir = resolve(raw.replace(/^~(?=$|\/)/, homedir()))
      const existing = workspaceAt(dir)
      if (existing) return { workspaceId: existing.id, created: false, rootDir: dir }
      mkdirSync(dir, { recursive: true })
      const initialized = gitInit !== false && !existsSync(join(dir, '.git'))
      if (initialized) await promisify(execFile)('git', ['init'], { cwd: dir })
      await sendRemoteCommand('createWorkspace', '', { name: label, rootDir: dir })
      const ws = await waitFor(() => workspaceAt(dir), 10_000)
      if (!ws) return 'Requested; the workspace has not appeared yet — check get_state.'
      return { workspaceId: ws.id, created: true, rootDir: dir, gitInitialized: initialized }
    },
  },
  {
    name: 'update_workspace',
    description: "Rename a workspace and/or change its color (hex like #6366f1) or emoji. Fields left out stay as they are.",
    inputSchema: { type: 'object', properties: { workspaceId: str, name: str, color: str, emoji: str }, required: ['workspaceId'] },
    run: async ({ workspaceId, name, color, emoji }) => {
      const ws = workspace(workspaceId)
      const updates: Json = {}
      if (typeof name === 'string' && name.trim()) updates.name = name.trim()
      if (typeof color === 'string') {
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('color must be a hex color like #6366f1')
        updates.color = color
      }
      if (typeof emoji === 'string' && emoji.trim()) updates.emoji = emoji.trim()
      if (!Object.keys(updates).length) throw new Error('Give a name, color or emoji to change')
      await sendRemoteCommand('updateWorkspace', '', { workspaceId: ws.id, updates })
      const done = await waitFor(() => Object.entries(updates).every(([k, v]) => workspace(ws.id)[k] === v) || null, 5_000)
      return done ? 'ok' : 'Requested; the change has not mirrored back yet — check get_state.'
    },
  },
  {
    name: 'delete_workspace',
    description:
      'Remove a workspace from Orchestra: kills every session in all its trees and forgets it. Files on disk, including its ' +
      "worktrees, are left alone (use remove_worktree first to delete those). Confirm with the user before calling.",
    inputSchema: { type: 'object', properties: { workspaceId: str }, required: ['workspaceId'] },
    annotations: { destructiveHint: true },
    run: async ({ workspaceId }) => {
      const ws = workspace(workspaceId)
      await sendRemoteCommand('deleteWorkspace', '', { workspaceId: ws.id })
      const gone = await waitFor(() => !mirror().workspaces.some((w) => w.id === ws.id) || null, 5_000)
      return gone ? `Removed ${ws.name}.` : 'Requested; the workspace is still listed — check get_state.'
    },
  },
  {
    name: 'remove_worktree',
    description: "Delete a worktree: kills its sessions, backs it up and removes it from disk. The main checkout (index 0) can't be removed.",
    inputSchema: { type: 'object', properties: { workspaceId: str, treeIndex: { type: 'integer', minimum: 1 } }, required: ['workspaceId', 'treeIndex'] },
    annotations: { destructiveHint: true },
    run: async ({ workspaceId, treeIndex }) => {
      const ws = workspace(workspaceId)
      if (!Number.isInteger(treeIndex) || treeIndex < 1 || !ws.trees[treeIndex]) throw new Error('treeIndex must name a worktree (>= 1)')
      await sendRemoteCommand('removeWorktree', '', { workspaceId: ws.id, treeIndex })
      return 'ok'
    },
  },
  {
    name: 'update_worktree',
    description:
      "Change a tree's sidebar label (displayName; empty string shows the branch again) and/or rename its git branch " +
      '(`git branch -m` in the tree).',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: str, treeIndex: int, displayName: str, branch: str },
      required: ['workspaceId', 'treeIndex'],
    },
    run: async ({ workspaceId, treeIndex, displayName, branch }) => {
      const ws = workspace(workspaceId)
      const index = requireTree(ws, treeIndex)
      if (typeof displayName !== 'string' && typeof branch !== 'string') throw new Error('Give a displayName or branch to change')
      if (typeof branch === 'string') {
        if (!branch.trim()) throw new Error('branch must not be empty')
        try {
          await promisify(execFile)('git', ['branch', '-m', branch.trim()], { cwd: ws.trees[index].rootDir })
        } catch (err: any) {
          throw new Error(`git branch -m failed: ${(err?.stderr || err?.message || err).toString().trim()}`)
        }
      }
      if (typeof displayName === 'string') {
        await sendRemoteCommand('updateWorktree', '', { workspaceId: ws.id, treeIndex: index, displayName })
      }
      return 'ok'
    },
  },
  {
    name: 'open_session',
    description: 'Open a new terminal or agent (claude/codex/cursor, launched with bypass permissions) in a tree and focus it. Returns the new sessionId.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: str, treeIndex: { ...int, description: "Defaults to the workspace's active tree." }, agent: { enum: AGENTS } },
      required: ['workspaceId', 'agent'],
    },
    run: async ({ workspaceId, treeIndex, agent }) => {
      const ws = workspace(workspaceId)
      if (!AGENTS.includes(agent)) throw new Error(`agent must be one of ${AGENTS.join(', ')}`)
      const index = Number.isInteger(treeIndex) ? treeIndex : ws.activeTreeIndex
      if (!ws.trees[index]) throw new Error(`No tree ${index} in ${ws.name}`)
      const before = treeSessionIds(ws.id, index)
      await sendRemoteCommand('spawnInTree', '', { workspaceId: ws.id, treeIndex: index, agent, origin: 'mcp' })
      const sessionId = await awaitNewSession(ws.id, index, before, 10_000)
      return sessionId ? { sessionId } : 'Requested; the session has not appeared yet — check get_state.'
    },
  },
  {
    name: 'run_action',
    description: "Run one of a workspace's custom actions (ids from get_state), in a given tree or the active one. Returns the session it opened, if any.",
    inputSchema: { type: 'object', properties: { workspaceId: str, actionId: str, treeIndex: int }, required: ['workspaceId', 'actionId'] },
    run: async ({ workspaceId, actionId, treeIndex }) => runAction(workspaceId, actionId, treeIndex),
  },
  {
    name: 'create_action',
    description:
      "Add a custom action to a workspace (the buttons in its nav bar). Returns its actionId, which run_action takes.",
    inputSchema: { type: 'object', properties: { workspaceId: str, ...ACTION_PROPS }, required: ['workspaceId', 'name'] },
    run: async (args) => {
      const ws = workspace(args.workspaceId)
      const fields = actionFields(args)
      if (!fields.name?.trim()) throw new Error('name is required')
      const id = randomUUID()
      await sendRemoteCommand('saveAction', '', { workspaceId: ws.id, action: { ...fields, id } })
      const added = await waitFor(() => workspace(ws.id).customActions.some((a: any) => a.id === id) || null, 5_000)
      return added ? { actionId: id } : 'Requested; the action has not mirrored back yet — check get_state.'
    },
  },
  {
    name: 'update_action',
    description: "Change a workspace's custom action. Fields left out stay as they are.",
    inputSchema: { type: 'object', properties: { workspaceId: str, actionId: str, ...ACTION_PROPS }, required: ['workspaceId', 'actionId'] },
    run: async (args) => {
      const ws = workspace(args.workspaceId)
      const id = requireAction(ws, args.actionId)
      const fields = actionFields(args)
      if (!Object.keys(fields).length) throw new Error('Give at least one field to change')
      await sendRemoteCommand('saveAction', '', { workspaceId: ws.id, action: { ...fields, id } })
      return 'ok'
    },
  },
  {
    name: 'delete_action',
    description: "Remove a custom action from a workspace. Sessions it already opened keep running.",
    inputSchema: { type: 'object', properties: { workspaceId: str, actionId: str }, required: ['workspaceId', 'actionId'] },
    annotations: { destructiveHint: true },
    run: async ({ workspaceId, actionId }) => {
      const ws = workspace(workspaceId)
      const id = requireAction(ws, actionId)
      await sendRemoteCommand('deleteAction', '', { workspaceId: ws.id, actionId: id })
      return 'ok'
    },
  },
  {
    name: 'read_terminal',
    description:
      "A session's terminal as plain text (screen plus scrollback, last `lines` lines). Pass waitForIdleSeconds to first wait " +
      'until the session stops working and its output settles — e.g. after sending a prompt to an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: str,
        lines: { type: 'integer', minimum: 1, maximum: 5000, default: 120 },
        waitForIdleSeconds: { type: 'number', minimum: 0, maximum: 1800 },
      },
      required: ['sessionId'],
    },
    annotations: { readOnlyHint: true },
    run: async ({ sessionId, lines, waitForIdleSeconds }) => {
      const id = requireSession(sessionId)
      let timedOut = false
      if (waitForIdleSeconds > 0) {
        // Give a just-sent prompt a moment to flip the agent to working first.
        await sleep(1_500)
        const idle = await waitFor(
          () => (mirror().liveStatus[id]?.work !== 'working' && !hasRecentTerminalOutput(id, 2_000)) || null,
          waitForIdleSeconds * 1_000,
        )
        timedOut = !idle
      }
      const status = mirror().liveStatus[id] ?? {}
      const header = `[work: ${status.work ?? 'idle'}${status.attention ? `, waiting for ${status.attention}` : ''}${status.exited ? ', exited' : ''}${timedOut ? ', still busy after wait' : ''}]`
      return `${header}\n${await readTerminal(id, Math.min(Number(lines) || 120, 5_000))}`
    },
  },
  {
    name: 'send_input',
    description:
      'Type into a session. `text` is sent as one paste; `keys` are pressed after it (enter, tab, shift-tab, escape, backspace, space, ' +
      'up/down/left/right, ctrl-<letter>); `submit` (default true when text is given) presses Enter once the terminal settles — ' +
      'which is what submits a prompt to claude/codex. For a shell command, send it as text with submit.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: str, text: str, keys: { type: 'array', items: str }, submit: { type: 'boolean' } },
      required: ['sessionId'],
    },
    run: async ({ sessionId, text, keys, submit }) => {
      const id = requireSession(sessionId)
      const keyList: string[] = Array.isArray(keys) ? keys.map(keyBytes) : []
      if (typeof text === 'string' && text) {
        await settle(id)
        await sendRemoteCommand('write', id, { data: text })
      }
      // One key per write: a multi-byte write reads as a paste to agent TUIs.
      for (const bytes of keyList) {
        await settle(id, 150, 1_000)
        await sendRemoteCommand('write', id, { data: bytes })
      }
      if (submit ?? (typeof text === 'string' && text.length > 0)) {
        await settle(id)
        await sendRemoteCommand('write', id, { data: '\r' })
      }
      return 'ok'
    },
  },
  {
    name: 'update_session',
    description: 'Rename a session ("" clears the custom name), pin it to the top of its list, and/or move it one place up or down.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: str, title: str, pinned: { type: 'boolean' }, move: { enum: ['up', 'down'] } },
      required: ['sessionId'],
    },
    run: async ({ sessionId, title, pinned, move }) => {
      const id = requireSession(sessionId)
      if (move !== undefined && move !== 'up' && move !== 'down') throw new Error('move must be up or down')
      if (typeof title === 'string') await sendRemoteCommand('renameSession', id, { title })
      if (typeof pinned === 'boolean') await sendRemoteCommand('setSessionPinned', id, { pinned })
      if (move) await sendRemoteCommand('moveSession', id, { sessionId: id, direction: move })
      return 'ok'
    },
  },
  {
    name: 'close_session',
    description: 'Kill a session\'s process and close its pane, like closing the tab on the desktop.',
    inputSchema: { type: 'object', properties: { sessionId: str }, required: ['sessionId'] },
    annotations: { destructiveHint: true },
    run: async ({ sessionId }) => {
      await sendRemoteCommand('kill', requireSession(sessionId))
      return 'ok'
    },
  },
  {
    name: 'update_status',
    description:
      'The desktop auto-updater: currentVersion, whether an update is available or already downloaded (availableVersion), ' +
      'download percent, restartPending once install_update was accepted, and any updater error message.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => updateStatus(),
  },
  {
    name: 'install_update',
    description:
      "Restart Orchestra into the downloaded update, like the phone's Restart & update button. Terminals survive (the daemon " +
      'keeps them) but this MCP connection drops while the app restarts. With nothing downloaded it starts an update check ' +
      'instead; call update_status to follow it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
    run: async () => {
      const before = updateStatus()
      if (!before.supported) throw new Error('This build has no update channel (dev or unsigned build).')
      if (before.restartPending) return `Already restarting into ${before.availableVersion ?? 'the update'}.`
      await sendRemoteCommand('restartToUpdate', '')
      if (!before.updateDownloaded) return `No update downloaded on ${before.currentVersion}; started an update check.`
      const restarting = await waitFor(() => updateStatus().restartPending || null, 5_000)
      return restarting
        ? `Restarting ${before.currentVersion} → ${before.availableVersion}.`
        : 'Requested; the desktop has not confirmed the restart yet — check update_status.'
    },
  },
]

async function runAction(workspaceId: unknown, actionId: unknown, treeIndex: unknown): Promise<unknown> {
  const ws = workspace(workspaceId)
  requireAction(ws, actionId)
  const index = Number.isInteger(treeIndex) ? (treeIndex as number) : ws.activeTreeIndex
  if (!ws.trees[index]) throw new Error(`No tree ${index} in ${ws.name}`)
  const before = treeSessionIds(ws.id, index)
  await sendRemoteCommand('spawnInTree', '', { workspaceId: ws.id, treeIndex: index, agent: null, actionId, origin: 'mcp' })
  const sessionId = await awaitNewSession(ws.id, index, before, 5_000)
  return sessionId ? { sessionId } : 'Started (no new session appeared — it may run in the background or reuse one).'
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/**
 * One tool per custom action — the buttons in each workspace's action bar —
 * named run_<workspace>_<action>, so an agent can call "Ship" in Orchestra
 * without first fishing its id out of get_state. Built from the live state on
 * every list/call, so a new action shows up the next time a client lists
 * tools. The four built-in agent buttons are open_session's job.
 */
function actionTools(): Tool[] {
  let workspaces: any[]
  try {
    workspaces = mirror().workspaces
  } catch {
    return [] // not published yet: only the fixed tools
  }
  const persisted = loadPersistedData().workspaces
  const taken = new Set(TOOLS.map((t) => t.name))
  const tools: Tool[] = []
  for (const ws of workspaces) {
    for (const action of persisted[ws.id]?.customActions ?? []) {
      if (action.id.startsWith('default-') || !ws.customActions.some((a: any) => a.id === action.id)) continue
      const base = `run_${slug(ws.name) || 'workspace'}_${slug(action.name) || 'action'}`.slice(0, 60)
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base}_${n}`
      taken.add(name)
      const command = (action.command ?? '').trim().replace(/\s+/g, ' ')
      tools.push({
        name,
        description:
          `Run the "${action.name}" action of the ${ws.name} workspace (its action-bar button; workspaceId ${ws.id}, actionId ${action.id}). ` +
          `${action.actionType ?? 'cli'}${action.runInBackground ? ', runs in the background' : ''}` +
          (command ? `: ${command.length > 240 ? `${command.slice(0, 240)}…` : command}` : '') +
          '. Returns the session it opened, if any.',
        inputSchema: {
          type: 'object',
          properties: { treeIndex: { ...int, description: "Which tree to run it in; defaults to the workspace's active tree." } },
        },
        run: async ({ treeIndex }) => runAction(ws.id, action.id, treeIndex),
      })
    }
  }
  return tools
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

async function dispatch(method: string, params: Json): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'orchestra', version: app.getVersion() },
        instructions:
          'Controls the Orchestra desktop app. Start with get_state. To hand work to an agent: open_session (or create_worktree ' +
          'with spinUp), send_input with the prompt, then read_terminal with waitForIdleSeconds. Workspaces, worktrees, sessions ' +
          'and actions each have create/update/delete tools, and every custom action has its own run_<workspace>_<action> tool.',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: [...TOOLS, ...actionTools()].map(({ run: _run, ...tool }) => tool) }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name) ?? actionTools().find((t) => t.name === params.name)
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 })
      try {
        const result = await tool.run(params.arguments ?? {})
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

/** One JSON-RPC message in, its response out (null for notifications). */
export async function handleMcpMessage(message: Json): Promise<Json | null> {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }
  }
  if (message.id === undefined) return null
  try {
    return { jsonrpc: '2.0', id: message.id, result: await dispatch(message.method, message.params ?? {}) }
  } catch (err: any) {
    return { jsonrpc: '2.0', id: message.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } }
  }
}
