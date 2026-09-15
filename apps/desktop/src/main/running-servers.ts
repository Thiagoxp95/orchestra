// src/main/running-servers.ts
//
// "Servers" = every TCP port a terminal session's process tree is listening on.
// A `turbo dev` in one session spawns a fan of dev servers (next, vite, expo,
// convex...) whose URLs are printed once and then scroll away; this module
// asks the kernel instead of the scrollback, so the list stays true even after
// the output is gone.
//
// Ownership: we walk UP from each listening pid through the process table until
// we hit a pid the daemon reports as a session shell. That attributes a port to
// the session that started it no matter how deep turbo/npm/node nest it.
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import type { RunningServer, RunningServerKind } from '../shared/types'
import { readTailscaleStatus } from './tailscale'

export interface ListenerEntry {
  pid: number
  port: number
  host: string
}

export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export interface HostAddresses {
  /** First non-internal LAN IPv4 (192.168.x, 10.x, ...). */
  lan?: string
  /** Tailscale IPv4 — the 100.64.0.0/10 CGNAT range Tailscale assigns. */
  tailnet?: string
  /** MagicDNS name of this machine ("<machine>.tail<n>.ts.net"). */
  tailnetHost?: string
}

const MAX_TREE_WALK = 30

/** macOS hands ephemeral client/HMR ports out of this range — never a dev server. */
const EPHEMERAL_PORT_FLOOR = 49152

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fn` field output into listener rows. */
export function parseLsofListeners(stdout: string): ListenerEntry[] {
  const out: ListenerEntry[] = []
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10)
      if (!Number.isFinite(pid)) pid = 0
      continue
    }
    if (!line.startsWith('n') || !pid) continue
    const name = line.slice(1)
    const match = name.match(/^(.*):(\d+)$/)
    if (!match) continue
    const port = Number.parseInt(match[2], 10)
    if (!Number.isFinite(port) || port <= 0) continue
    const host = match[1].replace(/^\[|\]$/g, '')
    out.push({ pid, port, host })
  }
  return out
}

/**
 * One process can bind the same port on IPv4 and IPv6 (and on several
 * interfaces). Collapse to one row per pid+port, preferring the wildcard bind
 * because that's the one reachable from the LAN/tailnet.
 */
export function dedupeListeners(entries: ListenerEntry[]): ListenerEntry[] {
  const byKey = new Map<string, ListenerEntry>()
  for (const entry of entries) {
    const key = `${entry.pid}:${entry.port}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, entry)
      continue
    }
    const isWildcard = entry.host === '*' || entry.host === '0.0.0.0' || entry.host === '::'
    const existingWildcard = existing.host === '*' || existing.host === '0.0.0.0' || existing.host === '::'
    if (isWildcard && !existingWildcard) byKey.set(key, entry)
  }
  return [...byKey.values()]
}

/** Parse `ps -eo pid=,ppid=,command=`. */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      command: match[3],
    })
  }
  return rows
}

export function buildParentMap(rows: ProcessRow[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const row of rows) map.set(row.pid, row.ppid)
  return map
}

export function buildCommandMap(rows: ProcessRow[]): Map<number, string> {
  const map = new Map<number, string>()
  for (const row of rows) map.set(row.pid, row.command)
  return map
}

/** Every pid below `rootPid`, deepest first — the order a kill should follow. */
export function collectDescendants(rootPid: number, rows: ProcessRow[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const ordered: number[] = []
  const walk = (pid: number, depth: number): void => {
    if (depth > MAX_TREE_WALK) return
    for (const child of children.get(pid) ?? []) {
      walk(child, depth + 1)
      ordered.push(child)
    }
  }
  walk(rootPid, 0)
  return ordered
}

/**
 * Walk up from a listening pid to the session shell that (transitively) started
 * it. Returns null when the process belongs to nothing Orchestra runs.
 */
export function resolveOwnerSession(
  pid: number,
  parentMap: Map<number, number>,
  sessionPidToId: Map<number, string>,
): string | null {
  let current = pid
  for (let i = 0; i < MAX_TREE_WALK; i++) {
    const owner = sessionPidToId.get(current)
    if (owner) return owner
    const parent = parentMap.get(current)
    if (!parent || parent === current || parent <= 1) return null
    current = parent
  }
  return null
}

/** Pick the LAN and Tailscale IPv4 addresses out of the interface table. */
export function pickAddresses(interfaces: ReturnType<typeof networkInterfaces>): HostAddresses {
  const result: HostAddresses = {}
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const octets = addr.address.split('.').map((n) => Number.parseInt(n, 10))
      // 100.64.0.0/10 — the CGNAT block Tailscale hands out.
      const isTailnet = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
      if (isTailnet) {
        result.tailnet ??= addr.address
      } else {
        result.lan ??= addr.address
      }
    }
  }
  return result
}

const KIND_PATTERNS: [RegExp, RunningServerKind][] = [
  [/\bexpo\b|expo[\\/]|\bmetro\b|react-native[\\/]cli/, 'expo'],
  [/\bnext\b|next-server|next[\\/]dist/, 'next'],
  [/\bvite\b/, 'vite'],
  [/\bconvex\b/, 'convex'],
  [/storybook/, 'storybook'],
  [/\bwrangler\b|workerd/, 'wrangler'],
  [/webpack|\breact-scripts\b/, 'webpack'],
  [/uvicorn|gunicorn|manage\.py|\bflask\b|\bpython[\d.]*\b/, 'python'],
  [/\brails\b|\bpuma\b/, 'rails'],
  [/\bdocker\b|com\.docker/, 'docker'],
]

export function detectKind(command: string): RunningServerKind {
  const lower = command.toLowerCase()
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(lower)) return kind
  }
  return 'server'
}

/**
 * Name a server the way its owner thinks of it: the directory it runs in
 * ("web", "mobile", "backend" in a turborepo), falling back to what it is.
 */
export function describeServer(command: string, cwd: string | undefined, kind: RunningServerKind): string {
  const dir = cwd ? path.basename(cwd) : ''
  if (dir && dir !== '/' && dir !== '.' && dir !== path.sep) return dir
  if (kind !== 'server') return kind
  const first = command.trim().split(/\s+/)[0] ?? ''
  return path.basename(first) || 'server'
}

/**
 * Every way to reach one port. `remote` is the one a phone should open: a
 * tailnet host beats the LAN address (works off the Wi-Fi), and localhost is
 * only ever a fallback for a viewer sitting at this machine.
 */
export function buildServerUrls(
  port: number,
  kind: RunningServerKind,
  addrs: HostAddresses,
): { local: string; lan?: string; tailnet?: string; remote: string; deepLink?: string } {
  const local = `http://localhost:${port}`
  // MagicDNS name over the raw 100.x address: it survives a Tailscale IP change
  // and is what Expo itself prints.
  const tailnetHost = addrs.tailnetHost ?? addrs.tailnet
  const urls: { local: string; lan?: string; tailnet?: string; remote: string; deepLink?: string } = {
    local,
    remote: local,
  }
  if (addrs.lan) urls.lan = `http://${addrs.lan}:${port}`
  if (tailnetHost) urls.tailnet = `http://${tailnetHost}:${port}`
  urls.remote = urls.tailnet ?? urls.lan ?? local
  if (kind === 'expo') {
    const host = tailnetHost ?? addrs.lan ?? '127.0.0.1'
    urls.deepLink = `exp://${host}:${port}`
  }
  return urls
}

/**
 * A dev server binds more than the port it advertises — vite adds an HMR
 * socket, and some tools open an inspector. One row per listening process is
 * the mental model, so pick the port the command line asked for, else the
 * lowest non-ephemeral one.
 */
export function pickPrimaryPort(command: string, ports: number[]): number {
  const flagged = command.match(/(?:--port[= ]|(?:^|\s)-p\s+)(\d{2,5})/)
  if (flagged) {
    const asked = Number.parseInt(flagged[1], 10)
    if (ports.includes(asked)) return asked
  }
  const stable = ports.filter((p) => p < EPHEMERAL_PORT_FLOOR)
  return Math.min(...(stable.length > 0 ? stable : ports))
}

export interface CollectInput {
  /** Live session shells, keyed by pid. */
  sessionPidToId: Map<number, string>
  listeners: ListenerEntry[]
  rows: ProcessRow[]
  cwdByPid: Map<number, string>
  addrs: HostAddresses
}

/** Pure core of the scan — everything above assembled into sidebar rows. */
export function collectRunningServers({
  sessionPidToId,
  listeners,
  rows,
  cwdByPid,
  addrs,
}: CollectInput): RunningServer[] {
  const parentMap = buildParentMap(rows)
  const commandMap = buildCommandMap(rows)
  // Group by process first: one dev server = one row, however many sockets it
  // opened (vite's HMR port, an inspector, an ephemeral helper).
  const portsByPid = new Map<number, number[]>()
  for (const entry of dedupeListeners(listeners)) {
    const list = portsByPid.get(entry.pid)
    if (list) list.push(entry.port)
    else portsByPid.set(entry.pid, [entry.port])
  }
  const servers: RunningServer[] = []
  for (const [pid, ports] of portsByPid) {
    const sessionId = resolveOwnerSession(pid, parentMap, sessionPidToId)
    if (!sessionId) continue
    const command = commandMap.get(pid) ?? ''
    const port = pickPrimaryPort(command, ports)
    const kind = detectKind(command)
    const cwd = cwdByPid.get(pid)
    servers.push({
      id: `${pid}:${port}`,
      pid,
      port,
      sessionId,
      command,
      cwd,
      kind,
      name: describeServer(command, cwd, kind),
      urls: buildServerUrls(port, kind, addrs),
    })
  }
  return servers.sort((a, b) => a.port - b.port)
}

// ---------------------------------------------------------------------------
// Shell-facing helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      resolve(stdout || '')
    })
  })
}

async function readCwds(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (pids.length === 0) return map
  // `-d cwd` asks only for the working-directory descriptor, so this stays one
  // cheap call even with a few dozen dev servers running.
  const stdout = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'])
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10)
    } else if (line.startsWith('n') && pid) {
      if (!map.has(pid)) map.set(pid, line.slice(1))
    }
  }
  return map
}

let cachedTailnetHost: { host?: string; at: number } | null = null
const TAILNET_TTL_MS = 5 * 60_000

/**
 * This machine's MagicDNS name. Cached: the phone needs it on every push, but
 * it only changes when the tailnet does.
 */
export async function readTailnetHost(now: number = Date.now()): Promise<string | undefined> {
  if (cachedTailnetHost && now - cachedTailnetHost.at < TAILNET_TTL_MS) return cachedTailnetHost.host
  const host = (await readTailscaleStatus()).dnsName ?? undefined
  cachedTailnetHost = { host, at: now }
  return host
}

/** Test seam for the MagicDNS cache. */
export function resetTailnetHostCache(): void {
  cachedTailnetHost = null
}

/** Full scan: ports → owning session → labelled, clickable URLs. */
export async function scanRunningServers(sessionPidToId: Map<number, string>): Promise<RunningServer[]> {
  if (sessionPidToId.size === 0) return []
  const [lsofOut, psOut] = await Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']),
    run('ps', ['-eo', 'pid=,ppid=,command=']),
  ])
  const listeners = dedupeListeners(parseLsofListeners(lsofOut))
  const rows = parsePsRows(psOut)
  const parentMap = buildParentMap(rows)
  const ownedPids = [
    ...new Set(
      listeners
        .filter((l) => resolveOwnerSession(l.pid, parentMap, sessionPidToId))
        .map((l) => l.pid),
    ),
  ]
  const [cwdByPid, tailnetHost] = await Promise.all([readCwds(ownedPids), readTailnetHost()])
  return collectRunningServers({
    sessionPidToId,
    listeners,
    rows,
    cwdByPid,
    addrs: { ...pickAddresses(networkInterfaces()), tailnetHost },
  })
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone, or not ours — either way there's nothing to kill.
  }
}

async function pidsHoldingPort(port: number): Promise<number[]> {
  const stdout = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Kill a dev server for real: SIGTERM the whole subtree (children first, so a
 * supervisor like turbo/nodemon can't respawn the worker it just lost), then
 * confirm against the kernel that the port is free and SIGKILL whoever still
 * holds it. "Killed it" has to mean the port is reusable, not that a signal
 * was delivered.
 */
export async function killRunningServer(
  pid: number,
  port: number,
): Promise<{ success: boolean; error?: string }> {
  const rows = parsePsRows(await run('ps', ['-eo', 'pid=,ppid=,command=']))
  const tree = [...collectDescendants(pid, rows), pid]
  for (const target of tree) signal(target, 'SIGTERM')

  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(250)
    const holders = await pidsHoldingPort(port)
    if (holders.length === 0) return { success: true }
    if (attempt === 3) {
      // Graceful shutdown had its second; take the port back.
      for (const holder of holders) {
        const holderTree = [...collectDescendants(holder, rows), holder]
        for (const target of holderTree) signal(target, 'SIGKILL')
      }
      for (const target of tree) signal(target, 'SIGKILL')
    }
  }

  const remaining = await pidsHoldingPort(port)
  if (remaining.length === 0) return { success: true }
  return { success: false, error: `Port ${port} is still held by pid ${remaining.join(', ')}` }
}
