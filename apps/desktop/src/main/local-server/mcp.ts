// src/main/local-server/mcp.ts
//
// An MCP server (streamable HTTP, stateless JSON responses) at POST /mcp, so
// other agents can drive Orchestra the way the phone does: read the workspace
// and session state, spawn worktrees and sessions, run actions, focus things on
// the desktop, and read from / type into any terminal.
//
// Every mutation goes through sendRemoteCommand — the phone's own serialized
// command path — so an agent can do exactly what the phone can and nothing the
// bridge hasn't already vetted. Loopback only: index.ts refuses requests that
// arrived through Tailscale Serve or carry a foreign Host/Origin.

import { app } from 'electron'
import { Terminal } from '@xterm/headless'
import { getDaemonClient } from '../daemon-client'
import { loadPersistedData } from '../persistence'
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

function mirror(): { workspaces: any[]; sessions: Record<string, any>; liveStatus: Record<string, any>; activeWorkspaceId: string | null; activeSessionId: string | null } {
  const state = getRemoteState()
  if (!state) throw new Error('Orchestra has not published its state yet')
  return state as any
}

function workspace(id: unknown): any {
  const ws = mirror().workspaces.find((w) => w.id === id)
  if (!ws) throw new Error(`Unknown workspaceId "${id}". Call get_state for the list.`)
  return ws
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
      activeTreeIndex: w.activeTreeIndex,
      trees: w.trees.map((t: any, index: number) => ({
        index,
        branch: t.branch ?? null,
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
        })),
      })),
      actions: (persisted[w.id]?.customActions ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        command: a.command,
        ...(a.runInBackground ? { background: true } : {}),
      })),
    })),
  }
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

const TOOLS: Tool[] = [
  {
    name: 'get_state',
    description:
      'Everything Orchestra shows: workspaces, their trees (index 0 = main checkout, others = git worktrees) with branch/PR, ' +
      'the sessions in each tree (type terminal/claude/codex/cursor, work idle|working, attention when waiting on the user), ' +
      "each workspace's custom actions with their commands, and what is focused. A process running inside Orchestra finds " +
      'its own session id in $ORCHESTRA_SESSION_ID.',
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
      'Waits up to 60s for the tree to appear and returns its index and sessions.',
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
        workspaceId: ws.id, branch, selectedActionIds: actionIds ?? [], spinUp: spinUp ?? null,
      })
      const index = await waitFor(() => {
        const trees = workspace(ws.id).trees
        return trees.length > before ? trees.length - 1 : null
      }, 60_000)
      if (index === null) return 'Requested; the worktree has not appeared yet — check get_state.'
      if (spinUp) await awaitNewSession(ws.id, index, [], 10_000)
      return { treeIndex: index, sessionIds: treeSessionIds(ws.id, index) }
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
      await sendRemoteCommand('spawnInTree', '', { workspaceId: ws.id, treeIndex: index, agent })
      const sessionId = await awaitNewSession(ws.id, index, before, 10_000)
      return sessionId ? { sessionId } : 'Requested; the session has not appeared yet — check get_state.'
    },
  },
  {
    name: 'run_action',
    description: "Run one of a workspace's custom actions (ids from get_state), in a given tree or the active one. Returns the session it opened, if any.",
    inputSchema: { type: 'object', properties: { workspaceId: str, actionId: str, treeIndex: int }, required: ['workspaceId', 'actionId'] },
    run: async ({ workspaceId, actionId, treeIndex }) => {
      const ws = workspace(workspaceId)
      if (!ws.customActions.some((a: any) => a.id === actionId)) throw new Error(`Unknown actionId "${actionId}" in ${ws.name}`)
      const index = Number.isInteger(treeIndex) ? treeIndex : ws.activeTreeIndex
      if (!ws.trees[index]) throw new Error(`No tree ${index} in ${ws.name}`)
      const before = treeSessionIds(ws.id, index)
      await sendRemoteCommand('spawnInTree', '', { workspaceId: ws.id, treeIndex: index, agent: null, actionId })
      const sessionId = await awaitNewSession(ws.id, index, before, 5_000)
      return sessionId ? { sessionId } : 'Started (no new session appeared — it may run in the background or reuse one).'
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
    description: 'Rename a session and/or pin it to the top of its list.',
    inputSchema: { type: 'object', properties: { sessionId: str, title: str, pinned: { type: 'boolean' } }, required: ['sessionId'] },
    run: async ({ sessionId, title, pinned }) => {
      const id = requireSession(sessionId)
      if (typeof title === 'string') await sendRemoteCommand('renameSession', id, { title })
      if (typeof pinned === 'boolean') await sendRemoteCommand('setSessionPinned', id, { pinned })
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
]

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
          'with spinUp), send_input with the prompt, then read_terminal with waitForIdleSeconds.',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ run: _run, ...tool }) => tool) }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name)
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
