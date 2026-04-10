# Claude Code Hook-Based Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite Claude Code session state detection to use Claude Code hooks as the sole source of truth, with a one-click install button and first-run nag banner.

**Architecture:** Claude Code fires hooks → bash notify script POSTs to a local HTTP server running in Orchestra's main process → state machine updates `NormalizedAgentSessionStatus` → IPC push to renderer → sidebar shimmer/spinner/idle indicators render. Pattern mirrors the existing `codex-hook-runtime.ts` scaffold. An install button in the NavBar writes the hook entries into `~/.claude/settings.json` with self-test verification; a first-run banner nudges users who run `claude` before installing.

**Tech Stack:** Electron (main + renderer + preload IPC), Node `http` server, Bash notify script, React 19 + Tailwind + zustand for UI, vitest for unit tests.

**Design doc:** `docs/plans/2026-04-09-claude-hooks-detection-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Create a worktree for this feature**

```bash
cd /Users/txp/Pessoal/orchestra
git worktree add ../orchestra-claude-hooks -b feature/claude-hooks-detection
cd ../orchestra-claude-hooks
```

- [ ] **Step 0.2: Verify worktree is on the new branch**

Run: `git branch --show-current`
Expected: `feature/claude-hooks-detection`

- [ ] **Step 0.3: Install deps + confirm tests pass on a clean base**

Run: `bun install && bun --cwd apps/desktop run test`
Expected: All existing tests pass.

---

## Phase 1 — Shared infrastructure: hook server, port file, env injection

This phase builds the plumbing every hook event will flow through. No Claude-specific logic yet. When Phase 1 is done, we have an HTTP server running in main, terminals spawned with `ORCHESTRA_HOOK_PORT` set, and a registration API ready for routes.

### Task 1: `hook-server.ts` — HTTP server module

**Files:**
- Create: `apps/desktop/src/main/hook-server.ts`
- Create: `apps/desktop/src/main/hook-server.test.ts`

- [ ] **Step 1.1: Write the failing test**

```ts
// apps/desktop/src/main/hook-server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHookServer, type HookServer } from './hook-server'

describe('hook-server', () => {
  let server: HookServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('starts on an ephemeral 127.0.0.1 port and exposes it', async () => {
    server = await createHookServer()
    expect(server.port).toBeGreaterThan(0)
    expect(server.host).toBe('127.0.0.1')
  })

  it('dispatches GET requests to registered route handlers with parsed query', async () => {
    server = await createHookServer()
    const received: Array<Record<string, string>> = []
    server.registerGetRoute('/test/hook', async (query) => {
      received.push({ ...query })
      return { status: 204 }
    })

    const res = await fetch(`http://127.0.0.1:${server.port}/test/hook?sessionId=abc&eventType=Start`)
    expect(res.status).toBe(204)
    expect(received).toEqual([{ sessionId: 'abc', eventType: 'Start' }])
  })

  it('returns 404 for unregistered routes', async () => {
    server = await createHookServer()
    const res = await fetch(`http://127.0.0.1:${server.port}/unknown`)
    expect(res.status).toBe(404)
  })

  it('returns 405 for non-GET methods', async () => {
    server = await createHookServer()
    server.registerGetRoute('/only-get', async () => ({ status: 204 }))
    const res = await fetch(`http://127.0.0.1:${server.port}/only-get`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/hook-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement `hook-server.ts`**

```ts
// apps/desktop/src/main/hook-server.ts
// Tiny HTTP server bound to 127.0.0.1 for receiving hook events from
// external helper scripts (claude-notify.sh, codex-notify.sh, …).
//
// Design constraints:
//   - Bind to 127.0.0.1 ONLY. Never publicly accessible.
//   - Ephemeral port chosen by the OS; the port is written to a file
//     the daemon reads at terminal spawn time.
//   - GET-only — matches `curl -G --data-urlencode` in the helper scripts
//     and keeps the handler synchronous-ish.

import * as http from 'node:http'

export type HookQuery = Record<string, string>

export interface HookResponse {
  status: number
  body?: string
}

export type HookGetHandler = (query: HookQuery) => Promise<HookResponse> | HookResponse

export interface HookServer {
  readonly host: string
  readonly port: number
  registerGetRoute(path: string, handler: HookGetHandler): void
  stop(): Promise<void>
}

const HOST = '127.0.0.1'

export async function createHookServer(): Promise<HookServer> {
  const routes = new Map<string, HookGetHandler>()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`)
      const handler = routes.get(url.pathname)
      if (!handler) {
        res.statusCode = 404
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end()
        return
      }

      const query: HookQuery = {}
      url.searchParams.forEach((value, key) => { query[key] = value })

      const result = await handler(query)
      res.statusCode = result.status
      if (result.body !== undefined) {
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(result.body)
      } else {
        res.end()
      }
    } catch (err) {
      console.error('[hook-server] handler error', err)
      res.statusCode = 500
      res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('[hook-server] failed to acquire listening address')
  }

  return {
    host: HOST,
    port: address.port,
    registerGetRoute(path, handler) {
      routes.set(path, handler)
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/hook-server.test.ts`
Expected: PASS — all 4 cases green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/desktop/src/main/hook-server.ts apps/desktop/src/main/hook-server.test.ts
git commit -m "feat(main): add local hook-server for external helper scripts"
```

### Task 2: Hook port file — writer (main) + helper (shared)

**Files:**
- Create: `apps/desktop/src/main/hook-port-file.ts`
- Create: `apps/desktop/src/main/hook-port-file.test.ts`

- [ ] **Step 2.1: Write the failing test**

```ts
// apps/desktop/src/main/hook-port-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getHookPortFilePath, writeHookPortFile, readHookPortFile } from './hook-port-file'

describe('hook-port-file', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hookport-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('derives the path from the Orchestra home dir', () => {
    const p = getHookPortFilePath({ HOME: tmpHome })
    expect(p).toBe(path.join(tmpHome, '.orchestra-dev', 'hook-port.txt'))
  })

  it('writes the port atomically and reads it back', () => {
    writeHookPortFile(45678, { HOME: tmpHome })
    expect(readHookPortFile({ HOME: tmpHome })).toBe(45678)
  })

  it('returns null when the file is missing', () => {
    expect(readHookPortFile({ HOME: tmpHome })).toBe(null)
  })

  it('returns null when the file is not a valid port', () => {
    const p = getHookPortFilePath({ HOME: tmpHome })
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'not-a-number')
    expect(readHookPortFile({ HOME: tmpHome })).toBe(null)
  })
})
```

Note: the test assumes `NODE_ENV !== 'production'` in vitest → `getOrchestraHomeDir()` returns `.orchestra-dev`. If vitest runs with a different env, adjust the expected path accordingly.

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/hook-port-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement `hook-port-file.ts`**

```ts
// apps/desktop/src/main/hook-port-file.ts
// Small helper to publish the hook-server port into a well-known file under
// the Orchestra home dir. The daemon reads this at terminal-spawn time and
// injects ORCHESTRA_HOOK_PORT into the child env.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHomeDir } from './orchestra-paths'

const PORT_FILE_NAME = 'hook-port.txt'

export function getHookPortFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHomeDir(env), PORT_FILE_NAME)
}

export function writeHookPortFile(port: number, env: NodeJS.ProcessEnv = process.env): void {
  const target = getHookPortFilePath(env)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(port), 'utf8')
  fs.renameSync(tmp, target)
}

export function readHookPortFile(env: NodeJS.ProcessEnv = process.env): number | null {
  const target = getHookPortFilePath(env)
  try {
    const raw = fs.readFileSync(target, 'utf8').trim()
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return null
    return n
  } catch {
    return null
  }
}

export function removeHookPortFile(env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(getHookPortFilePath(env))
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/hook-port-file.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add apps/desktop/src/main/hook-port-file.ts apps/desktop/src/main/hook-port-file.test.ts
git commit -m "feat(main): add hook-port file for daemon→main coordination"
```

### Task 3: Wire `ORCHESTRA_HOOK_PORT` env injection into the daemon's terminal spawn

**Files:**
- Modify: `apps/desktop/src/daemon/session.ts` (all three spawn sites: ~334, ~434, ~670)

- [ ] **Step 3.1: Read the exact current env-injection lines**

Run: `rg -n "ORCHESTRA_SESSION_ID: this.processSessionId" apps/desktop/src/daemon/session.ts`
Expected: 3 hits around lines 334, 434, 670.

- [ ] **Step 3.2: Add a small helper near the top of `session.ts`**

Near the other imports and module-level helpers, add:

```ts
// Compute env vars Orchestra injects into every spawned child.
// Reads the hook-server port from the shared file written by main.
function orchestraChildEnv(sessionId: string): Record<string, string> {
  const env: Record<string, string> = { ORCHESTRA_SESSION_ID: sessionId }
  try {
    // Late-require to avoid a top-level coupling to main-only modules.
    // The file path is computed purely from env, no electron imports.
    const { readHookPortFile } = require('../main/hook-port-file') as typeof import('../main/hook-port-file')
    const port = readHookPortFile()
    if (port) env.ORCHESTRA_HOOK_PORT = String(port)
  } catch {
    // Port file unavailable — hooks will early-exit, which is fine.
  }
  return env
}
```

Alternatively, if the daemon package shouldn't import from main/, duplicate the 8-line `readHookPortFile` into a shared helper under `daemon/` (see Task 3.2-alt below).

- [ ] **Step 3.2-alt: If the daemon must not import from main/, place the helper in `daemon/hook-port-file.ts`**

In that case, create `apps/desktop/src/daemon/hook-port-file.ts` with the `readHookPortFile` + `getHookPortFilePath` exports only (writer stays in main). Re-export from `main/hook-port-file.ts` by delegating to the daemon copy, to keep one source of truth.

> The subagent executing this task should pick the variant that matches the repo's existing main/daemon import rules. Run `rg "from '\\.\\./main" apps/desktop/src/daemon` to decide: any hits → the boundary is porous, use 3.2. No hits → the daemon is isolated, use 3.2-alt.

- [ ] **Step 3.3: Replace each `ORCHESTRA_SESSION_ID: this.processSessionId` site**

At every occurrence (around lines 334, 434, 670), replace:

```ts
ORCHESTRA_SESSION_ID: this.processSessionId,
```

with:

```ts
...orchestraChildEnv(this.processSessionId),
```

And for the two spawn sites wrapped by `suppressSessionIdEnv` (lines 434 and 670), replace:

```ts
...(this.suppressSessionIdEnv ? {} : { ORCHESTRA_SESSION_ID: this.processSessionId }),
```

with:

```ts
...(this.suppressSessionIdEnv ? {} : orchestraChildEnv(this.processSessionId)),
```

- [ ] **Step 3.4: Update the existing `session-startup` test fixture so `ORCHESTRA_HOOK_PORT` is optional**

Open `apps/desktop/src/daemon/session-startup.test.ts`. The existing test at line 51–56 asserts an exact string. If the `buildShellEnvBootstrapCommand` helper takes the env object as input (which it does per the test), the test is unchanged — it still receives explicit values. Verify by running:

Run: `bun --cwd apps/desktop run test src/daemon/session-startup.test.ts`
Expected: PASS — no changes needed.

- [ ] **Step 3.5: Commit**

```bash
git add apps/desktop/src/daemon/session.ts
git commit -m "feat(daemon): inject ORCHESTRA_HOOK_PORT into spawned terminals"
```

### Task 4: Start the hook server in main and publish the port on `app.whenReady`

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 4.1: Add imports near the top of `main/index.ts`**

After the existing `import { getDaemonClient } from './daemon-client'` line:

```ts
import { createHookServer, type HookServer } from './hook-server'
import { writeHookPortFile, removeHookPortFile } from './hook-port-file'
```

- [ ] **Step 4.2: Add a module-level holder for the server**

Near `let mainWindow: BrowserWindow | null = null`:

```ts
let hookServer: HookServer | null = null
```

- [ ] **Step 4.3: Start the server before `createWindow` calls any daemon-dependent init**

The server must be running and its port published **before** the daemon spawns any terminals. `app.whenReady().then(async () => { await createWindow() })` is where main currently boots. Find that block and add, as the first thing inside the handler (before `await createWindow()`):

```ts
hookServer = await createHookServer()
writeHookPortFile(hookServer.port)
console.log(`[main] hook server listening on 127.0.0.1:${hookServer.port}`)
```

- [ ] **Step 4.4: Clean up on quit**

Find the existing `app.on('before-quit', ...)` or `app.on('window-all-closed', ...)` handlers. Add this cleanup alongside the existing shutdown calls (e.g. next to `stopAllWatchers()`):

```ts
if (hookServer) {
  await hookServer.stop().catch(() => {})
  hookServer = null
}
removeHookPortFile()
```

If there is no async-capable shutdown path, use `hookServer.stop().catch(() => {})` fire-and-forget.

- [ ] **Step 4.5: Manual smoke test**

Run: `bun --cwd apps/desktop run dev`
Open a terminal in a running Orchestra workspace and run:

```bash
echo $ORCHESTRA_HOOK_PORT
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/unknown"
```

Expected: first command prints a non-empty port, second prints `404`.

- [ ] **Step 4.6: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(main): boot hook server on startup and publish port to daemon"
```

---

## Phase 2 — Claude hook runtime: notify script generator + installer + state machine

### Task 5: `claude-hook-runtime.ts` — script generator + auto-updating ensure function

**Files:**
- Create: `apps/desktop/src/main/claude-hook-runtime.ts`
- Create: `apps/desktop/src/main/claude-hook-runtime.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
// apps/desktop/src/main/claude-hook-runtime.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CLAUDE_HOOK_VERSION,
  buildClaudeNotifyScript,
  getClaudeHookRuntimePaths,
  ensureClaudeHookRuntimeInstalled,
} from './claude-hook-runtime'

describe('claude-hook-runtime', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-rt-'))
  })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('bakes the current version into the script', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
  })

  it('early-exits when ORCHESTRA_SESSION_ID is absent', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain('[ -z "$ORCHESTRA_SESSION_ID" ] && exit 0')
    expect(script).toContain('[ -z "$ORCHESTRA_HOOK_PORT" ] && exit 0')
  })

  it('recognizes the 6 wired event names', () => {
    const script = buildClaudeNotifyScript()
    for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop']) {
      expect(script).toContain(ev)
    }
  })

  it('posts to /claude/hook on the hook server', () => {
    const script = buildClaudeNotifyScript()
    expect(script).toContain('curl -sG "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/claude/hook"')
  })

  it('always exit 0 to avoid breaking Claude turns', () => {
    const script = buildClaudeNotifyScript()
    expect(script.trimEnd().endsWith('exit 0')).toBe(true)
  })

  it('derives paths under the Orchestra hooks dir', () => {
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    expect(paths.notifyScriptPath).toBe(
      path.join(tmpHome, '.orchestra-dev', 'hooks', 'claude-notify.sh')
    )
  })

  it('ensureClaudeHookRuntimeInstalled writes the script and sets 0755', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    const stat = fs.statSync(paths.notifyScriptPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(paths.notifyScriptPath, 'utf8')).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
  })

  it('ensure is idempotent and overwrites stale content on version mismatch', () => {
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const paths = getClaudeHookRuntimePaths({ HOME: tmpHome })
    fs.writeFileSync(paths.notifyScriptPath, '#!/bin/bash\n# version=old\nexit 0\n', { mode: 0o755 })
    ensureClaudeHookRuntimeInstalled({ HOME: tmpHome })
    const content = fs.readFileSync(paths.notifyScriptPath, 'utf8')
    expect(content).toContain(`# version=${CLAUDE_HOOK_VERSION}`)
    expect(content).not.toContain('# version=old')
  })
})
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/claude-hook-runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `claude-hook-runtime.ts`**

```ts
// apps/desktop/src/main/claude-hook-runtime.ts
// Generates and installs the Claude Code hook notifier script. Mirrors
// codex-hook-runtime.ts but targets Claude's real hook system.
//
// The script lives at ~/.orchestra/hooks/claude-notify.sh and is
// rewritten on every Orchestra startup so its version stays in sync
// with the running build.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const CLAUDE_HOOK_VERSION = '1'

const NOTIFY_SCRIPT_NAME = 'claude-notify.sh'

export type ClaudeHookEventType =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'

export const CLAUDE_HOOK_EVENT_TYPES: readonly ClaudeHookEventType[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
]

export function getClaudeHookRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const hooksDir = getOrchestraHooksDir(env)
  return {
    hooksDir,
    notifyScriptPath: path.join(hooksDir, NOTIFY_SCRIPT_NAME),
  }
}

export function buildClaudeNotifyScript(): string {
  return `#!/bin/bash
# Orchestra Claude Code hook notifier
# version=${CLAUDE_HOOK_VERSION}
set -e

# Guard: exit silently when not spawned inside an Orchestra session
[ -z "$ORCHESTRA_SESSION_ID" ] && exit 0
[ -z "$ORCHESTRA_HOOK_PORT" ] && exit 0

# Read stdin JSON payload Claude Code supplies to hooks
INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

# Event type is passed as argv[1] — matches what we wire in settings.json.
# Unknown events exit silently so new Claude Code releases never break us.
EVENT_TYPE="\${1:-}"
case "$EVENT_TYPE" in
  UserPromptSubmit|PreToolUse|PostToolUse|PermissionRequest|Notification|Stop) ;;
  *) exit 0 ;;
esac

# Extract minimal fields without a jq dependency
CLAUDE_SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\\1/')
MESSAGE=$(printf '%s' "$INPUT" | grep -oE '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\\1/')

# Fire and forget — bounded latency so hooks never block Claude
curl -sG "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/claude/hook" \\
  --connect-timeout 1 --max-time 2 \\
  --data-urlencode "orchestraSessionId=$ORCHESTRA_SESSION_ID" \\
  --data-urlencode "claudeSessionId=$CLAUDE_SESSION_ID" \\
  --data-urlencode "eventType=$EVENT_TYPE" \\
  --data-urlencode "message=$MESSAGE" \\
  --data-urlencode "version=\${ORCHESTRA_HOOK_VERSION:-${CLAUDE_HOOK_VERSION}}" \\
  > /dev/null 2>&1 || true

exit 0
`
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  if (existing === content) {
    fs.chmodSync(filePath, mode)
    return
  }
  fs.writeFileSync(filePath, content, { mode })
}

/**
 * Ensure the Claude hook notify script is installed at the canonical path.
 * Does NOT touch ~/.claude/settings.json — that's the installer's job.
 * Safe to call on every app startup.
 */
export function ensureClaudeHookRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): void {
  const paths = getClaudeHookRuntimePaths(env)
  fs.mkdirSync(paths.hooksDir, { recursive: true })
  writeFileIfChanged(paths.notifyScriptPath, buildClaudeNotifyScript(), 0o755)
}

/**
 * Extract the `# version=X` marker from an installed script file.
 * Returns null if the file is missing or has no marker.
 */
export function readInstalledScriptVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = getClaudeHookRuntimePaths(env)
  try {
    const content = fs.readFileSync(paths.notifyScriptPath, 'utf8')
    const match = content.match(/^#\s*version=([^\s]+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}
```

- [ ] **Step 5.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/claude-hook-runtime.test.ts`
Expected: PASS — all 8 cases green.

- [ ] **Step 5.5: Commit**

```bash
git add apps/desktop/src/main/claude-hook-runtime.ts apps/desktop/src/main/claude-hook-runtime.test.ts
git commit -m "feat(main): add claude hook runtime script generator"
```

### Task 6: `claude-hook-installer.ts` — detect + merge `~/.claude/settings.json`

**Files:**
- Create: `apps/desktop/src/main/claude-hook-installer.ts`
- Create: `apps/desktop/src/main/claude-hook-installer.test.ts`

- [ ] **Step 6.1: Write the failing test**

```ts
// apps/desktop/src/main/claude-hook-installer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  detectClaudeHookInstallState,
  mergeClaudeHooksIntoSettings,
  installClaudeHooks,
  buildClaudeHookCommand,
} from './claude-hook-installer'
import { CLAUDE_HOOK_VERSION, ensureClaudeHookRuntimeInstalled, getClaudeHookRuntimePaths } from './claude-hook-runtime'

describe('claude-hook-installer', () => {
  let tmpHome: string
  let claudeDir: string
  let settingsPath: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-install-'))
    claudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    settingsPath = path.join(claudeDir, 'settings.json')
  })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  function env() {
    return { HOME: tmpHome }
  }

  describe('detectClaudeHookInstallState', () => {
    it('returns not-installed when script is missing', () => {
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns not-installed when script exists but settings.json does not', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns error when settings.json has a syntax error', () => {
      ensureClaudeHookRuntimeInstalled(env())
      fs.writeFileSync(settingsPath, '{ "hooks": }')
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('error')
      if (state.status === 'error') {
        expect(state.reason).toBe('settings-malformed')
      }
    })

    it('returns installed when all entries + script exist', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'UserPromptSubmit') }] }],
          PreToolUse:       [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PreToolUse') }] }],
          PostToolUse:      [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PostToolUse') }] }],
          PermissionRequest:[{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PermissionRequest') }] }],
          Notification:     [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Notification') }] }],
          Stop:             [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Stop') }] }],
        }
      }, null, 2))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed')
      if (state.status === 'installed') {
        expect(state.version).toBe(CLAUDE_HOOK_VERSION)
      }
    })

    it('returns not-installed when any one of the 6 events is missing', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          // 5 of 6 wired
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'UserPromptSubmit') }] }],
          PreToolUse:       [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PreToolUse') }] }],
          PostToolUse:      [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PostToolUse') }] }],
          PermissionRequest:[{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'PermissionRequest') }] }],
          Stop:             [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, 'Stop') }] }],
        }
      }))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('not-installed')
    })

    it('returns installed-stale when script version differs', () => {
      ensureClaudeHookRuntimeInstalled(env())
      const paths = getClaudeHookRuntimePaths(env())
      fs.writeFileSync(paths.notifyScriptPath, '#!/bin/bash\n# version=0\nexit 0\n', { mode: 0o755 })
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: Object.fromEntries(
          ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop'].map((ev) => [
            ev, [{ hooks: [{ type: 'command', command: buildClaudeHookCommand(paths.notifyScriptPath, ev) }] }],
          ])
        ),
      }))
      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed-stale')
      if (state.status === 'installed-stale') {
        expect(state.installedVersion).toBe('0')
        expect(state.currentVersion).toBe(CLAUDE_HOOK_VERSION)
      }
    })
  })

  describe('mergeClaudeHooksIntoSettings', () => {
    it('creates the hooks section and all 6 entries when empty', () => {
      const result = mergeClaudeHooksIntoSettings({}, '/tmp/claude-notify.sh')
      expect(Object.keys(result.hooks)).toEqual(
        expect.arrayContaining(['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop'])
      )
      for (const ev of ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop']) {
        const entries = result.hooks[ev]
        expect(Array.isArray(entries)).toBe(true)
        const has = entries.some((e: any) => e.hooks?.some((h: any) => String(h.command).includes('claude-notify.sh')))
        expect(has).toBe(true)
      }
    })

    it('is idempotent — re-merging adds nothing new', () => {
      const first = mergeClaudeHooksIntoSettings({}, '/tmp/claude-notify.sh')
      const second = mergeClaudeHooksIntoSettings(first, '/tmp/claude-notify.sh')
      expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
    })

    it('preserves unrelated sibling keys and unrelated hook entries', () => {
      const existing = {
        permissions: { allow: ['a', 'b'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python ~/.claude/ccnotify/ccnotify.py UserPromptSubmit' }] }],
        },
      }
      const result = mergeClaudeHooksIntoSettings(existing, '/tmp/claude-notify.sh')
      expect(result.permissions).toEqual({ allow: ['a', 'b'] })
      // CCNotify entry is preserved
      const ups = result.hooks.UserPromptSubmit
      expect(ups.length).toBe(2)
      expect(ups[0].hooks[0].command).toContain('ccnotify.py')
      expect(ups[1].hooks[0].command).toContain('claude-notify.sh')
    })
  })

  describe('installClaudeHooks', () => {
    it('writes the script + settings.json with all 6 entries', async () => {
      // Stub the self-test to always pass — we don't have `claude` on the test box
      const result = await installClaudeHooks({ env: env(), selfTest: async () => ({ ok: true }) })
      expect(result.ok).toBe(true)

      const paths = getClaudeHookRuntimePaths(env())
      expect(fs.existsSync(paths.notifyScriptPath)).toBe(true)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      for (const ev of ['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop']) {
        expect(settings.hooks[ev]).toBeDefined()
      }

      const state = detectClaudeHookInstallState(env())
      expect(state.status).toBe('installed')
    })

    it('refuses to install when settings.json is malformed', async () => {
      fs.writeFileSync(settingsPath, '{ broken')
      const result = await installClaudeHooks({ env: env(), selfTest: async () => ({ ok: true }) })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('settings-malformed')
    })

    it('rolls back to the pre-write settings when self-test fails', async () => {
      const preWrite = JSON.stringify({ permissions: { allow: ['x'] } }, null, 2)
      fs.writeFileSync(settingsPath, preWrite)
      const result = await installClaudeHooks({
        env: env(),
        selfTest: async () => ({ ok: false, detail: 'Invalid settings — key permissions.allow.0' }),
      })
      expect(result.ok).toBe(false)
      const after = fs.readFileSync(settingsPath, 'utf8')
      expect(after).toBe(preWrite)
    })
  })
})
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/claude-hook-installer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement `claude-hook-installer.ts`**

```ts
// apps/desktop/src/main/claude-hook-installer.ts
// Read/write ~/.claude/settings.json safely. Pure functions — no electron
// imports — so the merge logic is unit-testable against tmp dirs.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CLAUDE_HOOK_VERSION,
  CLAUDE_HOOK_EVENT_TYPES,
  ensureClaudeHookRuntimeInstalled,
  getClaudeHookRuntimePaths,
  readInstalledScriptVersion,
  type ClaudeHookEventType,
} from './claude-hook-runtime'

export type ClaudeHookInstallState =
  | { status: 'not-installed' }
  | { status: 'installed'; version: string }
  | { status: 'installed-stale'; installedVersion: string; currentVersion: string }
  | { status: 'error'; reason: 'settings-malformed' | 'settings-unreadable' | 'script-missing'; detail: string }

export type ClaudeHookInstallResult =
  | { ok: true }
  | { ok: false; reason: 'settings-malformed' | 'settings-unreadable' | 'claude-rejected-settings' | 'io-error'; detail?: string }

function getSettingsPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || ''
  return path.join(home, '.claude', 'settings.json')
}

export function buildClaudeHookCommand(notifyScriptPath: string, eventName: ClaudeHookEventType): string {
  return `bash ${notifyScriptPath} ${eventName}`
}

function entryRefersToOurScript(entry: any, notifyScriptBasename: string): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(notifyScriptBasename))
}

export function mergeClaudeHooksIntoSettings(existing: any, notifyScriptPath: string): any {
  const base = (existing && typeof existing === 'object') ? existing : {}
  const result: any = { ...base }
  const hooks = (result.hooks && typeof result.hooks === 'object') ? { ...result.hooks } : {}
  result.hooks = hooks

  const basename = path.basename(notifyScriptPath)

  for (const event of CLAUDE_HOOK_EVENT_TYPES) {
    const existingEntries: any[] = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    const alreadyWired = existingEntries.some((entry) => entryRefersToOurScript(entry, basename))
    if (alreadyWired) {
      hooks[event] = existingEntries
      continue
    }
    existingEntries.push({
      hooks: [{ type: 'command', command: buildClaudeHookCommand(notifyScriptPath, event) }],
    })
    hooks[event] = existingEntries
  }

  return result
}

export function detectClaudeHookInstallState(env: NodeJS.ProcessEnv = process.env): ClaudeHookInstallState {
  const paths = getClaudeHookRuntimePaths(env)
  if (!fs.existsSync(paths.notifyScriptPath)) {
    return { status: 'not-installed' }
  }

  const settingsPath = getSettingsPath(env)
  if (!fs.existsSync(settingsPath)) {
    return { status: 'not-installed' }
  }

  let parsed: any
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // Distinguish IO vs parse
    if (err instanceof SyntaxError) {
      return { status: 'error', reason: 'settings-malformed', detail }
    }
    return { status: 'error', reason: 'settings-unreadable', detail }
  }

  const basename = path.basename(paths.notifyScriptPath)
  const hooks = parsed && typeof parsed.hooks === 'object' ? parsed.hooks : {}
  for (const event of CLAUDE_HOOK_EVENT_TYPES) {
    const entries: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
    const wired = entries.some((entry) => entryRefersToOurScript(entry, basename))
    if (!wired) return { status: 'not-installed' }
  }

  const installedVersion = readInstalledScriptVersion(env)
  if (installedVersion === null) {
    return { status: 'error', reason: 'script-missing', detail: 'script has no version marker' }
  }
  if (installedVersion !== CLAUDE_HOOK_VERSION) {
    return { status: 'installed-stale', installedVersion, currentVersion: CLAUDE_HOOK_VERSION }
  }
  return { status: 'installed', version: installedVersion }
}

export interface InstallClaudeHooksOptions {
  env?: NodeJS.ProcessEnv
  /**
   * Run a probe that exercises Claude Code to verify settings.json still loads.
   * Default implementation runs `claude --debug hooks --print "ping"` and
   * scans stderr for `Invalid settings`. Injectable for tests.
   */
  selfTest?: () => Promise<{ ok: true } | { ok: false; detail: string }>
}

async function defaultSelfTest(): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill('SIGKILL') } catch {}
        resolve({ ok: true }) // treat timeout as ambiguous success
      }
    }, 5000)

    const child = spawn('claude', ['--debug', 'hooks', '--print', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: true }) // claude not on PATH → treat as ambiguous success
    })
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const rejectedMarkers = ['Invalid settings', 'key:']
      if (rejectedMarkers.some((m) => stderr.includes(m))) {
        resolve({ ok: false, detail: stderr.slice(-1024) })
      } else {
        resolve({ ok: true })
      }
    })
  })
}

export async function installClaudeHooks(opts: InstallClaudeHooksOptions = {}): Promise<ClaudeHookInstallResult> {
  const env = opts.env ?? process.env
  const selfTest = opts.selfTest ?? defaultSelfTest

  // 1. Make sure the hook script is in place (auto-update to latest version).
  try {
    ensureClaudeHookRuntimeInstalled(env)
  } catch (err) {
    return { ok: false, reason: 'io-error', detail: err instanceof Error ? err.message : String(err) }
  }

  const paths = getClaudeHookRuntimePaths(env)
  const settingsPath = getSettingsPath(env)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })

  // 2. Read + parse existing settings.json (if any). Keep the raw string for
  //    in-memory rollback after a failed self-test.
  let preWrite: string | null = null
  let parsed: any = {}
  if (fs.existsSync(settingsPath)) {
    try {
      preWrite = fs.readFileSync(settingsPath, 'utf8')
      parsed = JSON.parse(preWrite)
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { ok: false, reason: 'settings-malformed', detail: err.message }
      }
      return { ok: false, reason: 'settings-unreadable', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  // 3. Merge our entries (idempotent).
  const merged = mergeClaudeHooksIntoSettings(parsed, paths.notifyScriptPath)
  const nextContent = JSON.stringify(merged, null, 2) + '\n'

  // 4. Atomic write.
  const tmp = `${settingsPath}.orchestra.tmp`
  try {
    fs.writeFileSync(tmp, nextContent, 'utf8')
    fs.renameSync(tmp, settingsPath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    return { ok: false, reason: 'io-error', detail: err instanceof Error ? err.message : String(err) }
  }

  // 5. Self-test — roll back if Claude Code rejects the new file.
  const probe = await selfTest()
  if (!probe.ok) {
    if (preWrite !== null) {
      try {
        const rollbackTmp = `${settingsPath}.orchestra.rollback`
        fs.writeFileSync(rollbackTmp, preWrite, 'utf8')
        fs.renameSync(rollbackTmp, settingsPath)
      } catch {
        // best effort
      }
    } else {
      try { fs.unlinkSync(settingsPath) } catch {}
    }
    return { ok: false, reason: 'claude-rejected-settings', detail: probe.detail }
  }

  return { ok: true }
}
```

- [ ] **Step 6.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/claude-hook-installer.test.ts`
Expected: PASS — all ~10 cases green.

- [ ] **Step 6.5: Commit**

```bash
git add apps/desktop/src/main/claude-hook-installer.ts apps/desktop/src/main/claude-hook-installer.test.ts
git commit -m "feat(main): add claude hook installer with safe settings.json merge"
```

### Task 7: `claude-session-state.ts` — hook event → state machine

**Files:**
- Create: `apps/desktop/src/main/claude-session-state.ts`
- Create: `apps/desktop/src/main/claude-session-state.test.ts`

- [ ] **Step 7.1: Write the failing test**

```ts
// apps/desktop/src/main/claude-session-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createClaudeSessionState, type ClaudeHookEvent } from './claude-session-state'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

describe('claude-session-state', () => {
  let emitted: NormalizedAgentSessionStatus[]
  let state: ReturnType<typeof createClaudeSessionState>

  beforeEach(() => {
    emitted = []
    state = createClaudeSessionState({
      onStatusUpdate: (s) => emitted.push(s),
    })
  })

  function fire(ev: Partial<ClaudeHookEvent>): void {
    state.applyHookEvent({
      orchestraSessionId: 'orch-1',
      claudeSessionId: 'claude-a',
      eventType: 'UserPromptSubmit',
      message: '',
      ...ev,
    } as ClaudeHookEvent)
  }

  it('UserPromptSubmit → working', () => {
    fire({ eventType: 'UserPromptSubmit' })
    expect(emitted.at(-1)?.state).toBe('working')
    expect(emitted.at(-1)?.authority).toBe('claude-hooks')
  })

  it('PreToolUse heals a missed UserPromptSubmit', () => {
    fire({ eventType: 'PreToolUse' })
    expect(emitted.at(-1)?.state).toBe('working')
  })

  it('PostToolUse keeps state working', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PostToolUse' })
    expect(emitted.at(-1)?.state).toBe('working')
  })

  it('PermissionRequest → waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('Notification with permission text → waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Notification', message: 'Claude needs your permission to use Bash' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('Notification with waiting-for-input text → waitingUserInput', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Notification', message: 'Claude is waiting for your input' })
    expect(emitted.at(-1)?.state).toBe('waitingUserInput')
  })

  it('Notification with other text → no state change', () => {
    fire({ eventType: 'UserPromptSubmit' })
    const before = emitted.length
    fire({ eventType: 'Notification', message: 'Background task complete' })
    expect(emitted.length).toBe(before)
  })

  it('Stop → idle', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Stop' })
    expect(emitted.at(-1)?.state).toBe('idle')
  })

  it('PermissionRequest arriving right after Stop still overrides to waitingApproval', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'Stop' })
    fire({ eventType: 'PermissionRequest' })
    expect(emitted.at(-1)?.state).toBe('waitingApproval')
  })

  it('duplicate same-state events do not re-emit', () => {
    fire({ eventType: 'UserPromptSubmit' })
    fire({ eventType: 'PreToolUse' })
    fire({ eventType: 'PostToolUse' })
    expect(emitted.length).toBe(1)
  })

  it('onOrchestraSessionClosed clears internal state', () => {
    fire({ eventType: 'UserPromptSubmit' })
    state.onOrchestraSessionClosed('orch-1')
    emitted.length = 0
    fire({ eventType: 'PreToolUse' })
    expect(emitted.at(-1)?.state).toBe('working') // re-initialized cleanly
  })

  it('tracks latest claudeSessionId as metadata without triggering a state emit', () => {
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-a' })
    emitted.length = 0
    // Same orchestra session, new Claude session id (user ran /clear) — same state, no emit
    fire({ eventType: 'UserPromptSubmit', claudeSessionId: 'claude-b' })
    expect(emitted.length).toBe(0)
    expect(state.getLastClaudeSessionId('orch-1')).toBe('claude-b')
  })
})
```

- [ ] **Step 7.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/claude-session-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement `claude-session-state.ts`**

```ts
// apps/desktop/src/main/claude-session-state.ts
// Event-sourced state machine: Claude Code hook events →
// NormalizedAgentSessionStatus updates. Authority: 'claude-hooks'.
//
// Exported as a factory so tests can spin up fresh instances without
// module-global state leaking across cases.

import type { AgentSessionState, NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import type { ClaudeHookEventType } from './claude-hook-runtime'

export interface ClaudeHookEvent {
  orchestraSessionId: string
  claudeSessionId: string
  eventType: ClaudeHookEventType
  message: string
}

interface PerSessionState {
  current: AgentSessionState
  lastClaudeSessionId: string | null
}

export interface ClaudeSessionStateOptions {
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => void
}

export interface ClaudeSessionState {
  applyHookEvent(event: ClaudeHookEvent): void
  onOrchestraSessionClosed(orchestraSessionId: string): void
  getCurrentState(orchestraSessionId: string): AgentSessionState | null
  getLastClaudeSessionId(orchestraSessionId: string): string | null
}

function parseNotificationMessage(message: string): AgentSessionState | null {
  if (!message) return null
  const lower = message.toLowerCase()
  if (lower.includes('permission')) return 'waitingApproval'
  if (lower.includes('approval')) return 'waitingApproval'
  if (lower.includes('waiting for input') || lower.includes('waiting for your input')) return 'waitingUserInput'
  return null
}

function resolveNextState(
  prev: AgentSessionState,
  event: ClaudeHookEvent,
): AgentSessionState | null {
  switch (event.eventType) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      return 'waitingApproval'
    case 'Notification': {
      const derived = parseNotificationMessage(event.message)
      return derived ?? null
    }
    case 'Stop':
      return 'idle'
    default:
      return null
  }
}

export function createClaudeSessionState(opts: ClaudeSessionStateOptions): ClaudeSessionState {
  const sessions = new Map<string, PerSessionState>()

  function emitStatus(orchestraSessionId: string, next: AgentSessionState): void {
    const now = Date.now()
    const status: NormalizedAgentSessionStatus = {
      sessionId: orchestraSessionId,
      agent: 'claude',
      state: next,
      authority: 'claude-hooks',
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: now,
      updatedAt: now,
    }
    opts.onStatusUpdate(status)
  }

  return {
    applyHookEvent(event: ClaudeHookEvent): void {
      let entry = sessions.get(event.orchestraSessionId)
      if (!entry) {
        entry = { current: 'unknown', lastClaudeSessionId: null }
        sessions.set(event.orchestraSessionId, entry)
      }

      entry.lastClaudeSessionId = event.claudeSessionId || entry.lastClaudeSessionId

      const next = resolveNextState(entry.current, event)
      if (next === null) return
      if (next === entry.current) return
      entry.current = next
      emitStatus(event.orchestraSessionId, next)
    },

    onOrchestraSessionClosed(orchestraSessionId: string): void {
      sessions.delete(orchestraSessionId)
    },

    getCurrentState(orchestraSessionId: string): AgentSessionState | null {
      return sessions.get(orchestraSessionId)?.current ?? null
    },

    getLastClaudeSessionId(orchestraSessionId: string): string | null {
      return sessions.get(orchestraSessionId)?.lastClaudeSessionId ?? null
    },
  }
}
```

- [ ] **Step 7.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/claude-session-state.test.ts`
Expected: PASS — all 12 cases green.

- [ ] **Step 7.5: Commit**

```bash
git add apps/desktop/src/main/claude-session-state.ts apps/desktop/src/main/claude-session-state.test.ts
git commit -m "feat(main): add claude hook event state machine"
```

---

## Phase 3 — Wire hook events → renderer, delete old Claude detection

### Task 8: Main→renderer IPC channel for `NormalizedAgentSessionStatus` updates

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts` (if `ElectronAPI` has an explicit type — confirm in step)
- Modify: `apps/desktop/src/renderer/src/App.tsx` or wherever IPC listeners are installed

- [ ] **Step 8.1: Find where the renderer currently subscribes to main-side session updates**

Run: `rg -n "ipcRenderer.on\(|onProcessChange|onTerminalData" apps/desktop/src/preload/index.ts | head -20`

Expected: List of subscriber patterns. We'll mirror the `onProcessChange` shape exactly.

- [ ] **Step 8.2: Add `onNormalizedAgentState` to the preload API**

In `apps/desktop/src/preload/index.ts`, after the existing `onProcessChange`:

```ts
  onNormalizedAgentState: (
    callback: (status: import('../shared/agent-session-types').NormalizedAgentSessionStatus) => void,
  ) => {
    const handler = (_event: any, status: any) => callback(status)
    ipcRenderer.on('normalized-agent-state', handler)
    return () => { ipcRenderer.removeListener('normalized-agent-state', handler) }
  },
```

- [ ] **Step 8.3: Add the matching field on the `ElectronAPI` type**

In `apps/desktop/src/shared/types.ts`, find the `ElectronAPI` interface and add:

```ts
onNormalizedAgentState: (
  callback: (status: NormalizedAgentSessionStatus) => void,
) => () => void
```

(Ensure `NormalizedAgentSessionStatus` is already re-exported from `types.ts` — it is per the grep we ran earlier at line 439.)

- [ ] **Step 8.4: Subscribe in the renderer and pipe to the store**

Find where other IPC subscriptions are set up in the renderer — likely `apps/desktop/src/renderer/src/App.tsx` inside a `useEffect`. Add:

```ts
useEffect(() => {
  const setNormalizedAgentState = useAppStore.getState().setNormalizedAgentState
  const unsub = window.electronAPI.onNormalizedAgentState((status) => {
    setNormalizedAgentState(status)
  })
  return () => { unsub() }
}, [])
```

Import `useAppStore` from `./store/app-store` if not already imported.

- [ ] **Step 8.5: Smoke-test with a fake emit**

Temporarily add to `main/index.ts` inside `app.whenReady`:

```ts
setTimeout(() => {
  mainWindow?.webContents.send('normalized-agent-state', {
    sessionId: 'fake', agent: 'claude', state: 'working', authority: 'claude-hooks',
    connected: true, lastResponsePreview: '', lastTransitionAt: Date.now(), updatedAt: Date.now(),
  })
}, 3000)
```

Run `bun --cwd apps/desktop run dev`, open devtools in the renderer, run `useAppStore.getState().normalizedAgentState` in the console. Expect to see the `fake` entry 3 s after boot. Then remove the test emit.

- [ ] **Step 8.6: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(ipc): main→renderer channel for normalized agent state updates"
```

### Task 9: Register the `/claude/hook` route, wire the state machine, start the runtime

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 9.1: Add imports near the top**

```ts
import { createClaudeSessionState, type ClaudeHookEvent } from './claude-session-state'
import { ensureClaudeHookRuntimeInstalled } from './claude-hook-runtime'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'
```

- [ ] **Step 9.2: Add a module-level holder**

```ts
let claudeSessionState: ReturnType<typeof createClaudeSessionState> | null = null
```

- [ ] **Step 9.3: Inside `app.whenReady` handler, after `hookServer = await createHookServer()` and after `createWindow()` has set `mainWindow`**

```ts
// Ensure the hook script is up to date on every boot. Safe on every launch.
try {
  ensureClaudeHookRuntimeInstalled()
} catch (err) {
  console.error('[main] failed to install claude hook runtime:', err)
}

claudeSessionState = createClaudeSessionState({
  onStatusUpdate: (status: NormalizedAgentSessionStatus) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('normalized-agent-state', status)

    // Keep the existing idle-notifier hook wired: on Stop → idle we still
    // want the native notification + in-app toast. The state is already
    // resolved, so the notifier no longer scans terminal buffers.
    if (status.state === 'idle') {
      // Fire-and-forget — notifyIdleTransition signature unchanged.
      import('./idle-notifier').then(({ notifyIdleTransition }) => {
        notifyIdleTransition(status.sessionId, 'claude').catch(() => {})
      })
    }
  },
})

hookServer!.registerGetRoute('/claude/hook', async (query) => {
  const orchestraSessionId = query.orchestraSessionId
  const eventType = query.eventType as ClaudeHookEvent['eventType']
  if (!orchestraSessionId || !eventType) {
    return { status: 204 }
  }
  claudeSessionState!.applyHookEvent({
    orchestraSessionId,
    claudeSessionId: query.claudeSessionId ?? '',
    eventType,
    message: query.message ?? '',
  })
  return { status: 204 }
})
```

- [ ] **Step 9.4: When an Orchestra session closes, clean up**

Find `stopAllWatchers()` or the equivalent session-close path. Right after it, add:

```ts
claudeSessionState?.onOrchestraSessionClosed(sessionId)
```

In the matching per-session close handler (IPC `terminal-kill` or `terminal-exit`), add the same call after any existing cleanup.

- [ ] **Step 9.5: Compile-check**

Run: `bun --cwd apps/desktop run typecheck` (or `bun --cwd apps/desktop run build` — confirm which the repo uses)

Expected: no type errors.

- [ ] **Step 9.6: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(main): wire claude hook route + state machine into main process"
```

### Task 10: Update `idle-notifier.ts` — drop the TUI-scanning path

**Files:**
- Modify: `apps/desktop/src/main/idle-notifier.ts`

- [ ] **Step 10.1: Read the current `notifyIdleTransition` signature**

Open `apps/desktop/src/main/idle-notifier.ts`. Confirm the exported signature at line 198:

```ts
export async function notifyIdleTransition(
  sessionId: string,
  agentType: 'claude' | 'codex',
  lastResponse?: string,
  lastUserPrompt?: string,
  wasInterrupted?: boolean
): Promise<void>
```

- [ ] **Step 10.2: Simplify — accept a pre-resolved requiresUserInput, drop the TUI scanner**

Replace the function body so that for `agentType === 'claude'` the Claude-specific detection branch does not execute. For Codex, keep current behavior (we're not rewriting Codex detection).

Edit `notifyIdleTransition`:

```ts
export async function notifyIdleTransition(
  sessionId: string,
  agentType: 'claude' | 'codex',
  lastResponse?: string,
  lastUserPrompt?: string,
  wasInterrupted?: boolean,
  preResolvedRequiresUserInput?: boolean,  // NEW
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const gen = (notifyGeneration.get(sessionId) ?? 0) + 1
  notifyGeneration.set(sessionId, gen)

  const focused = mainWindow.isFocused()
  const isLookingAtSession = focused && sessionId === activeSessionId

  const defaultLabel = agentLabel(agentType)
  let requiresUserInput = preResolvedRequiresUserInput ?? false

  // For Claude: state was already resolved upstream via hooks.
  // For Codex (legacy path): keep the TUI-scanning fallback unchanged.
  if (agentType === 'codex' && !wasInterrupted && preResolvedRequiresUserInput === undefined) {
    const agentText = getAgentResponseText(sessionId)
    const textToAnalyze = agentText || getTerminalBufferText(sessionId)
    if (textToAnalyze) {
      requiresUserInput = detectRequiresUserInput(textToAnalyze)
    }
    if (!requiresUserInput && textToAnalyze) {
      requiresUserInput = detectQuestionInText(textToAnalyze)
    }
  }

  markWorkingStart(sessionId)

  // ... rest unchanged: summary derivation, dispatch, native notification, dock bounce.
}
```

The rest of the function (summary derivation, `webContents.send('idle-notification', ...)`, native notification, dock bounce) is untouched.

- [ ] **Step 10.3: Update the caller in `main/index.ts` Task 9.3 to pass pre-resolved state**

In the `onStatusUpdate` callback from Task 9.3:

```ts
if (status.state === 'idle') {
  import('./idle-notifier').then(({ notifyIdleTransition }) => {
    notifyIdleTransition(status.sessionId, 'claude', undefined, undefined, false, false).catch(() => {})
  })
}
if (status.state === 'waitingUserInput' || status.state === 'waitingApproval') {
  import('./idle-notifier').then(({ notifyIdleTransition }) => {
    notifyIdleTransition(status.sessionId, 'claude', undefined, undefined, false, true).catch(() => {})
  })
}
```

- [ ] **Step 10.4: Run existing idle-notifier/agent tests**

Run: `bun --cwd apps/desktop run test src/main/idle-notifier src/main/agent-idle-reaper`
Expected: PASS — we haven't broken the Codex path.

- [ ] **Step 10.5: Commit**

```bash
git add apps/desktop/src/main/idle-notifier.ts apps/desktop/src/main/index.ts
git commit -m "refactor(idle-notifier): accept pre-resolved requiresUserInput for claude"
```

### Task 11: Delete `claude-session-watcher.ts` and all its call sites

**Files:**
- Delete: `apps/desktop/src/main/claude-session-watcher.ts`
- Modify: `apps/desktop/src/main/index.ts` (remove imports + calls)
- Modify: `apps/desktop/src/preload/index.ts` (remove `claudeWatchSession`/`claudeUnwatchSession`/`claudeSessionStarted`)
- Modify: `apps/desktop/src/shared/types.ts` (remove those from `ElectronAPI`)
- Modify: `apps/desktop/src/renderer/src/...` (remove calls — see step 11.3)

- [ ] **Step 11.1: Find all call sites**

Run: `rg -n "claudeWatchSession|claudeUnwatchSession|claudeSessionStarted|initClaudeWatcher|watchSession|unwatchSession|observeTerminalData" apps/desktop/src/`

Expected: hit list across main/index.ts, preload/index.ts, shared/types.ts, and renderer files.

- [ ] **Step 11.2: Remove from main process**

In `apps/desktop/src/main/index.ts`:
- Delete line 11 (`import { initClaudeWatcher, watchSession, unwatchSession, stopAllWatchers } from './claude-session-watcher'`)
- Delete line ~150 (`initClaudeWatcher(mainWindow)`)
- Delete line ~361 (`watchSession(sessionId, cwd, claudePid)`) and the surrounding IPC handler if it only existed for this
- Remove `stopAllWatchers()` calls

Also remove IPC handlers for `claude-watch-session`, `claude-unwatch-session`, `claude-session-started`.

- [ ] **Step 11.3: Remove from renderer**

For each hit in renderer files (most likely `components/TerminalInstance.tsx` or `hooks/useAgentResponses.ts`):
- Delete calls to `window.electronAPI.claudeWatchSession(...)` / `claudeUnwatchSession(...)` / `claudeSessionStarted(...)`
- Clean up surrounding dead effects

The Sidebar and SessionItem already read from `normalizedAgentState` — no changes needed there.

- [ ] **Step 11.4: Remove from preload + types**

In `apps/desktop/src/preload/index.ts`, delete the `claudeWatchSession`, `claudeUnwatchSession`, `claudeSessionStarted` methods.
In `apps/desktop/src/shared/types.ts`, delete the matching fields on `ElectronAPI`.

- [ ] **Step 11.5: Delete the file**

```bash
git rm apps/desktop/src/main/claude-session-watcher.ts
```

- [ ] **Step 11.6: Typecheck + unit tests**

Run: `bun --cwd apps/desktop run typecheck && bun --cwd apps/desktop run test`
Expected: PASS. Any remaining compile errors point at missed call sites.

- [ ] **Step 11.7: Commit**

```bash
git add -u apps/desktop/src
git commit -m "refactor: remove claude-session-watcher — replaced by hook runtime"
```

### Task 12: Remove `'claude-watcher-fallback'` authority + legacy renderer fallback

**Files:**
- Modify: `apps/desktop/src/shared/agent-session-types.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts`

- [ ] **Step 12.1: Remove `'claude-watcher-fallback'` from the type union**

In `agent-session-types.ts`:

```ts
export type AgentSessionAuthority =
  | 'codex-app-server'
  | 'claude-hooks'
  | 'claude-jsonl'
  | 'codex-watcher-fallback'
  // 'claude-watcher-fallback' removed — Claude detection is hook-only
```

Also remove it from `VALID_AUTHORITIES`.

- [ ] **Step 12.2: Remove the Claude branch from the legacy fallback**

In `useNormalizedAgentState.ts`, keep the Codex legacy path but short-circuit Claude:

```ts
function deriveLegacyState(
  processStatus: 'claude' | 'codex',
  claudeWorkState: string | undefined,
  codexWorkState: string | undefined,
  needsInput: boolean | undefined,
): AgentSessionState | null {
  if (processStatus === 'claude') return null  // pure hooks — no fallback
  if (codexWorkState === 'waitingUserInput' || needsInput) return 'waitingUserInput'
  if (codexWorkState === 'waitingApproval') return 'waitingApproval'
  if (codexWorkState === 'working') return 'working'
  return 'idle'
}
```

And update the `fallback` memo so that when `legacyState === null` the fallback is `null`:

```ts
const fallback = useMemo(() => {
  if (normalized || !legacyState || processStatus === 'terminal') return null
  const status: NormalizedAgentSessionStatus = {
    sessionId,
    agent: processStatus as 'claude' | 'codex',
    state: legacyState,
    authority: 'codex-watcher-fallback',  // only codex takes this branch now
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: 0,
    updatedAt: 0,
  }
  return status
}, [normalized, legacyState, sessionId, processStatus])
```

- [ ] **Step 12.3: Typecheck**

Run: `bun --cwd apps/desktop run typecheck`
Expected: Any file still referencing `'claude-watcher-fallback'` fails — fix those sites.

Run: `rg -n "claude-watcher-fallback" apps/desktop/src/`
Expected: No hits after fixes.

- [ ] **Step 12.4: Commit**

```bash
git add apps/desktop/src/shared/agent-session-types.ts apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts
git commit -m "refactor(types): remove claude-watcher-fallback authority"
```

### Task 13: Trim `terminal-output-buffer.ts` dead paths (keep Codex path intact)

**Files:**
- Modify: `apps/desktop/src/main/terminal-output-buffer.ts`

- [ ] **Step 13.1: Search for all consumers of the exports we intend to remove**

Run: `rg -n "markWorkingStart|getAgentResponseText|workStartOffset|onRawTerminalData" apps/desktop/src/`

Expected: After Task 10, the only consumer of `markWorkingStart`/`getAgentResponseText` is the function bodies we already modified. If any renderer or main file still imports them, those are dead references.

- [ ] **Step 13.2: Delete the Claude-only helpers if they have no callers**

If the grep from 13.1 shows no callers outside the file itself: delete `markWorkingStart`, `getAgentResponseText`, and the `workStartOffset` field from `SessionBuffer`.

If Codex still uses them, leave them alone — this task is scoped to Claude.

- [ ] **Step 13.3: Run tests**

Run: `bun --cwd apps/desktop run test src/main/terminal-output-buffer.test.ts`
Expected: PASS (or update the test file if we deleted asserted exports).

- [ ] **Step 13.4: Commit**

```bash
git add apps/desktop/src/main/terminal-output-buffer.ts apps/desktop/src/main/terminal-output-buffer.test.ts
git commit -m "refactor(terminal-output-buffer): drop claude-only markWorkingStart path"
```

---

## Phase 4 — UI: install button, banner, IPC, running detector

### Task 14: `claude-running-detector.ts` — "is any Orchestra terminal running claude right now?"

**Files:**
- Create: `apps/desktop/src/main/claude-running-detector.ts`
- Create: `apps/desktop/src/main/claude-running-detector.test.ts`

- [ ] **Step 14.1: Write the failing test**

```ts
// apps/desktop/src/main/claude-running-detector.test.ts
import { describe, it, expect, vi } from 'vitest'
import { computeHasAnyClaudeRunning } from './claude-running-detector'

describe('claude-running-detector', () => {
  it('returns false for empty session list', () => {
    expect(computeHasAnyClaudeRunning([], () => [])).toBe(false)
  })

  it('returns true when any session has a process named "claude"', () => {
    const sessions = [{ id: 'a', pid: 100 }, { id: 'b', pid: 200 }]
    const getChildProcessNames = (_pid: number) => ['zsh', 'claude']
    expect(computeHasAnyClaudeRunning(sessions, getChildProcessNames)).toBe(true)
  })

  it('matches "claude" as a word, not a substring', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    const getChildProcessNames = (_pid: number) => ['claude-code', 'myclaude']
    expect(computeHasAnyClaudeRunning(sessions, getChildProcessNames)).toBe(false)
  })

  it('matches common claude binary variants', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    // Claude CLI is typically just "claude", but aliases may exist
    expect(computeHasAnyClaudeRunning(sessions, () => ['claude'])).toBe(true)
    expect(computeHasAnyClaudeRunning(sessions, () => ['node', 'claude'])).toBe(true)
  })

  it('returns false when no session has claude', () => {
    const sessions = [{ id: 'a', pid: 100 }]
    expect(computeHasAnyClaudeRunning(sessions, () => ['zsh', 'vim'])).toBe(false)
  })
})
```

- [ ] **Step 14.2: Run the test to verify it fails**

Run: `bun --cwd apps/desktop run test src/main/claude-running-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 14.3: Implement the module**

```ts
// apps/desktop/src/main/claude-running-detector.ts
// Minimal "is any terminal running claude" detector for the first-run banner.
//
// This is NOT a state machine — just a boolean signal used to gate the nag
// banner so users who never run claude inside Orchestra don't see it.

import { execFileSync } from 'node:child_process'
import type { BrowserWindow } from 'electron'

interface TerminalSessionPidView {
  id: string
  pid: number
}

export function computeHasAnyClaudeRunning(
  sessions: readonly TerminalSessionPidView[],
  getChildProcessNames: (pid: number) => readonly string[],
): boolean {
  for (const s of sessions) {
    const names = getChildProcessNames(s.pid)
    if (names.some((n) => n === 'claude')) return true
  }
  return false
}

export function getChildProcessNamesForPid(pid: number): readonly string[] {
  // Use pgrep -P to find direct children, then ps to get their names.
  // On failure, return empty (caller defaults to false).
  try {
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
    const names: string[] = []
    for (const childPid of children) {
      try {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', childPid], { encoding: 'utf8' }).trim()
        if (comm) names.push(comm.split('/').pop() || comm)
      } catch {
        // ignore — process may have exited between pgrep and ps
      }
    }
    return names
  } catch {
    return []
  }
}

export interface ClaudeRunningDetector {
  stop(): void
  getCurrent(): boolean
}

export function startClaudeRunningDetector(
  mainWindow: BrowserWindow,
  listSessions: () => readonly TerminalSessionPidView[],
  intervalMs: number = 2000,
): ClaudeRunningDetector {
  let current = false

  const tick = () => {
    const sessions = listSessions()
    const next = computeHasAnyClaudeRunning(sessions, getChildProcessNamesForPid)
    if (next !== current) {
      current = next
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-running-changed', current)
      }
    }
  }

  tick()
  const timer = setInterval(tick, intervalMs)

  return {
    stop() { clearInterval(timer) },
    getCurrent() { return current },
  }
}
```

- [ ] **Step 14.4: Run the test to verify it passes**

Run: `bun --cwd apps/desktop run test src/main/claude-running-detector.test.ts`
Expected: PASS.

- [ ] **Step 14.5: Commit**

```bash
git add apps/desktop/src/main/claude-running-detector.ts apps/desktop/src/main/claude-running-detector.test.ts
git commit -m "feat(main): minimal claude-running detector for first-run banner"
```

### Task 15: IPC surface for the install button + banner

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 15.1: Register IPC handlers in `main/index.ts`**

Near the other `ipcMain.handle` setup:

```ts
import {
  detectClaudeHookInstallState,
  installClaudeHooks,
  type ClaudeHookInstallState,
} from './claude-hook-installer'

// ...

ipcMain.handle('claude-hooks:get-state', async (): Promise<ClaudeHookInstallState> => {
  return detectClaudeHookInstallState()
})

ipcMain.handle('claude-hooks:install', async () => {
  const result = await installClaudeHooks()
  const nextState = detectClaudeHookInstallState()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-hooks:state-changed', nextState)
  }
  return result
})
```

And when the main window is created or gains focus, re-check:

```ts
mainWindow.on('focus', () => {
  const state = detectClaudeHookInstallState()
  mainWindow?.webContents.send('claude-hooks:state-changed', state)
})
```

- [ ] **Step 15.2: Start the running detector in main**

Near the rest of the `app.whenReady` boot, after `claudeSessionState` is created:

```ts
import { startClaudeRunningDetector } from './claude-running-detector'

// ...

const claudeRunningDetector = startClaudeRunningDetector(mainWindow, () => {
  // Return (sessionId, pid) pairs from the existing session registry.
  // Use listLiveSessionStatuses() or equivalent — whatever returns live pids.
  const live = listLiveSessionStatuses()
  return live
    .filter((s: any) => s && typeof s.pid === 'number')
    .map((s: any) => ({ id: s.sessionId, pid: s.pid }))
})
```

Store the handle on a module-level variable for cleanup:

```ts
let claudeRunningDetectorHandle: ReturnType<typeof startClaudeRunningDetector> | null = null
// ...
claudeRunningDetectorHandle = startClaudeRunningDetector(/* ... */)
```

And in the shutdown path:

```ts
claudeRunningDetectorHandle?.stop()
```

If `listLiveSessionStatuses()` doesn't expose pids, inspect it and the existing `TerminalSession` shape; add pid exposure in a minimal follow-up inside this task if needed.

- [ ] **Step 15.3: Add preload methods**

In `apps/desktop/src/preload/index.ts`:

```ts
claudeHooks: {
  getState: (): Promise<import('./../main/claude-hook-installer').ClaudeHookInstallState> => {
    return ipcRenderer.invoke('claude-hooks:get-state')
  },
  install: (): Promise<{ ok: boolean; reason?: string; detail?: string }> => {
    return ipcRenderer.invoke('claude-hooks:install')
  },
  onStateChanged: (
    cb: (state: import('./../main/claude-hook-installer').ClaudeHookInstallState) => void,
  ) => {
    const handler = (_event: any, state: any) => cb(state)
    ipcRenderer.on('claude-hooks:state-changed', handler)
    return () => { ipcRenderer.removeListener('claude-hooks:state-changed', handler) }
  },
  onAnyClaudeRunningChanged: (cb: (running: boolean) => void) => {
    const handler = (_event: any, running: boolean) => cb(running)
    ipcRenderer.on('claude-running-changed', handler)
    return () => { ipcRenderer.removeListener('claude-running-changed', handler) }
  },
},
```

Note: the `import('./../main/...')` type-only import will resolve via the renderer's tsconfig paths. If the monorepo tsconfig forbids crossing boundaries, duplicate the `ClaudeHookInstallState` type into `shared/types.ts` and import from there instead.

- [ ] **Step 15.4: Add to `ElectronAPI` type**

In `apps/desktop/src/shared/types.ts`, add under the `ElectronAPI` interface:

```ts
claudeHooks: {
  getState: () => Promise<ClaudeHookInstallState>
  install: () => Promise<{ ok: boolean; reason?: string; detail?: string }>
  onStateChanged: (cb: (state: ClaudeHookInstallState) => void) => () => void
  onAnyClaudeRunningChanged: (cb: (running: boolean) => void) => () => void
}
```

And export `ClaudeHookInstallState` from this file (either re-export from `claude-hook-installer.ts` or duplicate the union here to keep the renderer boundary clean).

- [ ] **Step 15.5: Typecheck**

Run: `bun --cwd apps/desktop run typecheck`
Expected: clean.

- [ ] **Step 15.6: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "feat(ipc): expose claudeHooks install/getState/running to renderer"
```

### Task 16: `useClaudeHookInstallState` hook + `ClaudeHooksButton` component

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useClaudeHookInstallState.ts`
- Create: `apps/desktop/src/renderer/src/components/ClaudeHooksButton.tsx`
- Modify: `apps/desktop/src/renderer/src/components/NavBar.tsx`

- [ ] **Step 16.1: Create the hook**

```tsx
// apps/desktop/src/renderer/src/hooks/useClaudeHookInstallState.ts
import { useEffect, useState } from 'react'
import type { ClaudeHookInstallState } from '../../../shared/types'

export function useClaudeHookInstallState(): {
  state: ClaudeHookInstallState | null
  refresh: () => void
  install: () => Promise<{ ok: boolean; reason?: string; detail?: string }>
} {
  const [state, setState] = useState<ClaudeHookInstallState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.claudeHooks.getState().then((s) => { if (!cancelled) setState(s) })
    const unsub = window.electronAPI.claudeHooks.onStateChanged((s) => setState(s))
    return () => { cancelled = true; unsub() }
  }, [])

  const refresh = () => {
    window.electronAPI.claudeHooks.getState().then(setState)
  }
  const install = () => window.electronAPI.claudeHooks.install()

  return { state, refresh, install }
}
```

- [ ] **Step 16.2: Create the button component**

```tsx
// apps/desktop/src/renderer/src/components/ClaudeHooksButton.tsx
import { useCallback, useState } from 'react'
import { useClaudeHookInstallState } from '../hooks/useClaudeHookInstallState'
import { Tooltip } from './Tooltip'

interface Props {
  wsColor: string
  txtColor: string
  onToast: (msg: string, kind: 'success' | 'error') => void
}

export function ClaudeHooksButton({ wsColor, txtColor, onToast }: Props) {
  const { state, install } = useClaudeHookInstallState()
  const [busy, setBusy] = useState(false)

  const handleClick = useCallback(async () => {
    if (!state) return

    if (state.status === 'error' && state.reason === 'settings-malformed') {
      // Open the file for manual fix
      window.electronAPI.openExternalPath?.('~/.claude/settings.json')
      return
    }
    if (state.status === 'installed' || state.status === 'installed-stale') return

    setBusy(true)
    try {
      const res = await install()
      if (res.ok) {
        onToast('Claude Code hooks installed', 'success')
      } else {
        onToast(`Install failed: ${res.reason}${res.detail ? ' — ' + res.detail : ''}`, 'error')
      }
    } finally {
      setBusy(false)
    }
  }, [state, install, onToast])

  if (!state) return null

  // Visual variants
  const baseClass = 'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors'
  const baseStyle = {
    color: txtColor,
    backgroundColor: `${txtColor}10`,
    border: `1px solid ${txtColor}18`,
  }

  if (state.status === 'installed' || state.status === 'installed-stale') {
    const version = state.status === 'installed' ? state.version : state.currentVersion
    return (
      <Tooltip side="top" text={`Claude Code hooks installed (v${version})`} bgColor={wsColor} textColor={txtColor}>
        <div className={`${baseClass} opacity-60 cursor-default`} style={baseStyle}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 8 7 12 13 4" />
          </svg>
          <span>Hooks installed</span>
        </div>
      </Tooltip>
    )
  }

  if (state.status === 'error' && state.reason === 'settings-malformed') {
    return (
      <Tooltip side="top" text="Can't install — your ~/.claude/settings.json has a syntax error. Click to open." bgColor={wsColor} textColor={txtColor}>
        <button
          onClick={handleClick}
          className={`${baseClass} hover:opacity-80`}
          style={{ ...baseStyle, color: '#f87171', borderColor: '#f8717133' }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2 L14 13 L2 13 Z" />
            <line x1="8" y1="6" x2="8" y2="10" />
            <circle cx="8" cy="11.5" r="0.5" />
          </svg>
          <span>Fix settings.json</span>
        </button>
      </Tooltip>
    )
  }

  // not-installed (or other error — treat as clickable install)
  return (
    <Tooltip side="top" text="Install Claude Code hooks into ~/.claude/settings.json" bgColor={wsColor} textColor={txtColor}>
      <button
        onClick={handleClick}
        disabled={busy}
        className={`${baseClass} hover:opacity-80 disabled:opacity-40`}
        style={baseStyle}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2 L8 10" />
          <path d="M5 7 L8 10 L11 7" />
          <path d="M3 13 L13 13" />
        </svg>
        <span>{busy ? 'Installing…' : 'Install Claude hooks'}</span>
      </button>
    </Tooltip>
  )
}
```

- [ ] **Step 16.3: Mount in `NavBar.tsx`**

In `apps/desktop/src/renderer/src/components/NavBar.tsx`, after the `<UsageBadge … />` line (~159):

```tsx
import { ClaudeHooksButton } from './ClaudeHooksButton'

// ...inside the right-aligned badges div, right after UsageBadge:
<ClaudeHooksButton
  wsColor={wsColor}
  txtColor={txtColor}
  onToast={(msg, kind) => showToast?.(msg, kind)}
/>
```

Find how the existing Skills button shows toasts (the `onToast` signature may already exist as a prop passed to NavBar, or via a global toast hook). Match that pattern — do not invent a new toast system.

If NavBar has no toast prop, use `useAppStore((s) => s.pushToast)` or whatever the existing toast store hook is named (run `rg "pushToast|showToast|addToast" apps/desktop/src/renderer/src/store/` to find it).

- [ ] **Step 16.4: Add `openExternalPath` to preload if not present**

Run: `rg -n "openExternalPath|shell.openPath" apps/desktop/src/preload apps/desktop/src/main`

If not present, add a small IPC:

In `main/index.ts`:
```ts
import { shell } from 'electron'
ipcMain.handle('open-external-path', async (_event, relativePath: string) => {
  const expanded = relativePath.startsWith('~')
    ? relativePath.replace('~', homedir())
    : relativePath
  await shell.openPath(expanded)
})
```

In preload:
```ts
openExternalPath: (p: string) => ipcRenderer.invoke('open-external-path', p),
```

In `shared/types.ts` add to `ElectronAPI`:
```ts
openExternalPath: (p: string) => Promise<void>
```

- [ ] **Step 16.5: Manual smoke test**

Run: `bun --cwd apps/desktop run dev`

Verify the button appears in the NavBar to the right of the Usage badge. Click it — expect either "installed" toast, or the install flow to proceed with a toast and the button to switch to green-check state.

- [ ] **Step 16.6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useClaudeHookInstallState.ts \
        apps/desktop/src/renderer/src/components/ClaudeHooksButton.tsx \
        apps/desktop/src/renderer/src/components/NavBar.tsx \
        apps/desktop/src/main/index.ts \
        apps/desktop/src/preload/index.ts \
        apps/desktop/src/shared/types.ts
git commit -m "feat(renderer): claude hooks install button in navbar"
```

### Task 17: First-run install banner

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ClaudeHookInstallBanner.tsx`
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts` (add `claudeBannerDismissed` + setter, not persisted)
- Modify: `apps/desktop/src/renderer/src/App.tsx` (mount the banner, subscribe to `onAnyClaudeRunningChanged`)

- [ ] **Step 17.1: Add the non-persisted flag to the store**

In `apps/desktop/src/renderer/src/store/app-store.ts`, add to the state shape:

```ts
claudeBannerDismissed: boolean  // not persisted — resets on app restart
anyClaudeRunning: boolean
```

Defaults:

```ts
claudeBannerDismissed: false,
anyClaudeRunning: false,
```

Setters:

```ts
setClaudeBannerDismissed: (v: boolean) => set({ claudeBannerDismissed: v }),
setAnyClaudeRunning: (v: boolean) => set({ anyClaudeRunning: v }),
```

- [ ] **Step 17.2: Create the banner component**

```tsx
// apps/desktop/src/renderer/src/components/ClaudeHookInstallBanner.tsx
import { useClaudeHookInstallState } from '../hooks/useClaudeHookInstallState'
import { useAppStore } from '../store/app-store'
import { useState } from 'react'

export function ClaudeHookInstallBanner() {
  const { state, install } = useClaudeHookInstallState()
  const anyClaudeRunning = useAppStore((s) => s.anyClaudeRunning)
  const dismissed = useAppStore((s) => s.claudeBannerDismissed)
  const setDismissed = useAppStore((s) => s.setClaudeBannerDismissed)
  const [busy, setBusy] = useState(false)

  if (dismissed) return null
  if (!state || state.status === 'installed' || state.status === 'installed-stale') return null
  if (!anyClaudeRunning) return null

  const handleInstall = async () => {
    setBusy(true)
    try {
      await install()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-2 text-sm"
      style={{
        backgroundColor: '#1a1a2e',
        borderBottom: '1px solid #2a2a3e',
        color: '#e5e7eb',
      }}
    >
      <div className="flex-1">
        <strong>Install Claude Code hooks</strong>
        <span className="opacity-80"> — Orchestra uses Claude Code hooks to track session state (working, idle, needs input). One click installs them to <code>~/.claude/settings.json</code>.</span>
      </div>
      <div className="flex gap-2 items-center ml-4">
        <button
          onClick={handleInstall}
          disabled={busy}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="px-2 py-1 rounded hover:bg-white/10 text-white/70"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 17.3: Subscribe to `anyClaudeRunning` in `App.tsx`**

Add in a `useEffect`:

```ts
useEffect(() => {
  const setAnyClaudeRunning = useAppStore.getState().setAnyClaudeRunning
  const unsub = window.electronAPI.claudeHooks.onAnyClaudeRunningChanged(setAnyClaudeRunning)
  return () => { unsub() }
}, [])
```

- [ ] **Step 17.4: Mount the banner at the top of the main content area**

Find the layout root in `App.tsx` (the component that wraps `NavBar`, `Sidebar`, and the terminal pane). Insert `<ClaudeHookInstallBanner />` right below the NavBar so it floats above the workspace tabs.

- [ ] **Step 17.5: Smoke test**

Fresh state: `rm ~/.orchestra/hooks/claude-notify.sh` (or `~/.orchestra-dev/hooks/claude-notify.sh` in dev) and remove the Orchestra hook entries from `~/.claude/settings.json`. Launch Orchestra, open a terminal, run `claude`. The banner should appear within ~2 s. Click Install. The banner should disappear and the NavBar button should show the green checkmark.

- [ ] **Step 17.6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/ClaudeHookInstallBanner.tsx \
        apps/desktop/src/renderer/src/store/app-store.ts \
        apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(renderer): first-run banner for claude hook install"
```

---

## Phase 5 — End-to-end verification

### Task 18: Manual end-to-end test matrix

- [ ] **Step 18.1: Clean slate install**

```bash
rm -f ~/.orchestra-dev/hooks/claude-notify.sh
# Back up your real settings.json and use a clean one for testing
cp ~/.claude/settings.json /tmp/settings.json.bak
echo '{}' > ~/.claude/settings.json
```

Launch `bun --cwd apps/desktop run dev`. Expected: NavBar shows "Install Claude hooks" button. No banner yet (no claude running). Click install. Expected: button flips to green "Hooks installed". Verify `~/.claude/settings.json` has all 6 hook entries and the script exists at `~/.orchestra-dev/hooks/claude-notify.sh`.

- [ ] **Step 18.2: Full state machine walk**

Inside Orchestra, open a terminal, run `claude`. Submit a prompt that triggers a tool use, e.g. `read the first 10 lines of package.json`. Watch the sidebar:
- While Claude responds → shimmer/working indicator
- When Claude emits Stop → idle indicator
- If a permission prompt appears → waitingApproval indicator

- [ ] **Step 18.3: First-run banner**

Restore settings: `cp /tmp/settings.json.bak ~/.claude/settings.json`. Remove just Orchestra's entries manually, leaving any other user entries intact. Restart Orchestra. Run `claude` in a terminal. Expected: banner appears at top of main content within ~2 s. Click Install — banner disappears, button shows green check.

- [ ] **Step 18.4: Coexistence with CCNotify**

Manually add a CCNotify-style entry to `settings.json` under `UserPromptSubmit`. Click install button (if not already installed). Expected: both entries present after install, CCNotify entry is preserved.

- [ ] **Step 18.5: Malformed settings.json**

Write a broken settings file: `echo '{ broken' > ~/.claude/settings.json`. Restart Orchestra. Expected: NavBar button shows red "Fix settings.json" state. Click it — expected: file opens in the default editor.

- [ ] **Step 18.6: Outside-Orchestra claude is unaffected**

Open a plain Terminal.app (not an Orchestra terminal). Run `claude --debug hooks --print "ping"`. Expected: the hook script runs for each event, sees `ORCHESTRA_SESSION_ID` is empty, exits 0 silently. No network requests in the Orchestra hook server log (look in `mainWindow.webContents` devtools console for any unexpected traffic).

- [ ] **Step 18.7: Restart + auto-update of script**

Bump `CLAUDE_HOOK_VERSION` in `claude-hook-runtime.ts` to `'1a'`. Rebuild, restart Orchestra. Expected: script file is silently overwritten with new version, button shows "Hooks installed" (not "installed-stale" since we also write the new version). Verify via `head -n 3 ~/.orchestra-dev/hooks/claude-notify.sh`. Revert the version bump before commit.

- [ ] **Step 18.8: Restore settings**

```bash
cp /tmp/settings.json.bak ~/.claude/settings.json
```

- [ ] **Step 18.9: Final typecheck + tests**

```bash
bun --cwd apps/desktop run typecheck
bun --cwd apps/desktop run test
```

Expected: clean.

- [ ] **Step 18.10: Commit any remaining fixes from the E2E pass**

```bash
git add -A
git commit -m "fix: address issues found in E2E verification" # if there are any
```

### Task 19: Open a draft PR

- [ ] **Step 19.1: Push the branch**

```bash
git push -u origin feature/claude-hooks-detection
```

- [ ] **Step 19.2: Create the PR**

```bash
gh pr create --draft --title "feat: rewrite claude code detection with hooks" --body "$(cat <<'EOF'
## Summary
- Rewrites Claude Code session state detection to use Claude Code hooks (UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop) as the sole source of truth.
- Adds a one-click "Install Claude hooks" button in the NavBar (right of the Usage badge).
- Adds a first-run nag banner that appears the first time `claude` is detected running inside an Orchestra terminal without hooks installed.
- Deletes terminal-output heuristics for Claude (`claude-session-watcher`, TUI-scan branches in `idle-notifier`), reducing drift and false positives.
- Builds shared infrastructure (local HTTP hook server in main, `ORCHESTRA_HOOK_PORT` injection into terminal spawns, main→renderer normalized-agent-state IPC channel) that future Codex work can reuse.

## Design
See `docs/plans/2026-04-09-claude-hooks-detection-design.md`.

## Test plan
- [ ] Unit tests pass (`bun --cwd apps/desktop run test`)
- [ ] Typecheck clean (`bun --cwd apps/desktop run typecheck`)
- [ ] Clean-slate install from NavBar button
- [ ] Banner appears on first `claude` run without hooks
- [ ] Sidebar state transitions match Claude turn lifecycle (working → idle → waitingApproval)
- [ ] Coexistence with CCNotify entries
- [ ] Malformed settings.json shows red "Fix settings.json" button
- [ ] Plain Terminal.app usage unaffected (hook script early-exits)
EOF
)"
```

---

## Self-Review (completed before handing off)

**Spec coverage check.** Every section of the spec maps to a task:
- Architecture Overview → Tasks 1, 2, 3, 4, 9
- Session matching (ORCHESTRA_SESSION_ID + _HOOK_PORT) → Tasks 2, 3, 4
- Global guard → Task 5 (script early-exit)
- Hook coverage (6 hooks) → Tasks 5, 7
- State machine & Stop/permission race → Task 7
- Hook script → Task 5
- Settings.json entries → Tasks 6, 15
- Installer (detect + install + self-test + rollback) → Task 6
- Auto-update split → Task 5 (ensure) + Task 6 (installClaudeHooks)
- HTTP endpoint → Tasks 1, 9
- Main→renderer IPC for NormalizedAgentSessionStatus → Task 8
- NavBar button (3 states) → Task 16
- First-run banner → Task 17
- Claude-running detector → Task 14
- Preload IPC surface → Task 15
- Deletion inventory → Tasks 11, 12, 13 + in-line trims in Task 10
- Infrastructure We're Building section → Tasks 1, 2, 3, 4, 8

**Placeholder scan.** No "TBD" / "implement later" / "similar to" references left in task steps. Each step that writes code shows the code.

**Type consistency.**
- `ClaudeHookInstallState`: defined in Task 6, used identically in Tasks 15, 16, 17.
- `ClaudeHookEvent`: defined in Task 7, used in Task 9 registration.
- `ClaudeHookEventType`: defined in Task 5, re-used in Tasks 6 (merge + detect) and 7 (state machine).
- `NormalizedAgentSessionStatus`: type imported from `shared/agent-session-types` in Tasks 7, 8, 9, 10 — all consistent.
- `CLAUDE_HOOK_VERSION`: referenced in Tasks 5, 6, and the manual E2E test 18.7 — all consistent.
- `CLAUDE_HOOK_EVENT_TYPES`: exported from Task 5, consumed in Tasks 6 and 7.
- IPC channel names:
  - `normalized-agent-state` (Task 8, 9)
  - `claude-hooks:get-state` / `claude-hooks:install` / `claude-hooks:state-changed` (Task 15)
  - `claude-running-changed` (Tasks 14, 15)
  - All consistent.
- Hook HTTP route: `/claude/hook` (Tasks 5, 9).

**Scope check.** One feature, one implementation plan. The infrastructure pieces (hook server, port file, env injection, IPC channel) are prerequisites for the Claude feature and don't introduce independent subsystems — each is a few-hundred-line module directly consumed by the Claude tasks.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-04-09-claude-hooks-detection-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

Which approach?
