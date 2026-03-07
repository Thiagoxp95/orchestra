# Persistent Terminal Daemon — Design

## Goal

Replace direct node-pty spawning with a persistent daemon architecture so terminal sessions (including running processes like Claude Code) survive app restarts.

## Architecture: Three-Process Design

```
Electron App (disposable)
  ├── DaemonLauncher — spawns/finds daemon
  ├── DaemonClient — 2 Unix sockets (control + stream)
  └── HistoryManager — cold restore fallback

Terminal Daemon (persistent, detached Node.js)
  ├── TerminalHost — session management
  ├── Session[] — one per terminal
  │   ├── HeadlessEmulator (@xterm/headless + SerializeAddon)
  │   └── PTY Subprocess handle
  └── Unix socket server (NDJSON protocol)

PTY Subprocess (one per terminal, child of daemon)
  └── node-pty shell spawn, binary framing over stdin/stdout
```

### Process 1: Terminal Daemon

- Detached Node.js process: `ELECTRON_RUN_AS_NODE=1`, `detached: true`, `unref()`
- PID file: `~/.orchestra/daemon.pid`
- Socket: `~/.orchestra/daemon.sock`
- Contains TerminalHost managing all Session objects
- Survives Electron quit

### Process 2: PTY Subprocess

- One per terminal session, child of daemon
- Spawns shell via node-pty
- Binary framing protocol over stdin/stdout:
  - Parent → child: Spawn(1), Write(2), Resize(3), Kill(4), Dispose(5), Signal(6)
  - Child → parent: Ready(101), Spawned(102), Data(103), Exit(104), Error(105)
  - Frame: 1 byte type + 4 bytes LE payload length + payload
- Output batching: coalesce every 32ms or 128KB
- Backpressure: pause PTY if stdout can't drain

### Process 3: Electron App

- Connects to daemon on startup via Unix socket
- DaemonClient opens 2 connections (control + stream)
- Renderer unchanged — still uses IPC, main process bridges to daemon
- HistoryManager writes scrollback to disk for cold restore

## Headless Emulator (per session)

- `@xterm/headless` terminal + `SerializeAddon`
- Tracks terminal modes via DECSET/DECRST parsing (cursor keys, mouse, bracketed paste, alt screen)
- Tracks CWD via OSC-7 parsing
- Async batched writes with time budgets (5ms with clients, 25ms without)
- `getSnapshot()` → `{ snapshotAnsi, rehydrateSequences, cwd, modes, cols, rows }`

## Dual Socket Protocol (NDJSON)

Both sockets connect to same Unix socket, distinguished by hello message role.

**Control socket** (request/response):
```json
→ {"id":1,"type":"createOrAttach","sessionId":"abc","cwd":"/foo","cols":80,"rows":24}
← {"id":1,"ok":true,"pid":1234,"snapshot":"...ansi...","isNew":true}

→ {"type":"write","sessionId":"abc","data":"ls\n"}  // fire-and-forget

→ {"id":2,"type":"resize","sessionId":"abc","cols":120,"rows":40}
← {"id":2,"ok":true}

→ {"id":3,"type":"kill","sessionId":"abc"}
← {"id":3,"ok":true}

→ {"id":4,"type":"listSessions"}
← {"id":4,"ok":true,"sessions":[{"sessionId":"abc","pid":1234,"cwd":"/foo"}]}
```

**Stream socket** (server-push events):
```json
← {"type":"event","event":"data","sessionId":"abc","data":"output here"}
← {"type":"event","event":"exit","sessionId":"abc","exitCode":0}
```

## Session Lifecycle

| Event | Flow |
|-------|------|
| Create | Electron → daemon `createOrAttach` → spawn PTY subprocess → create emulator → return empty snapshot |
| Type | Electron → daemon `write` (fire-and-forget) → daemon → PTY subprocess |
| Output | PTY subprocess → daemon (binary frame) → emulator.write() → stream socket → Electron → renderer |
| Resize | Electron → daemon `resize` → resize PTY + emulator |
| App quit | Socket disconnects. Daemon + PTYs keep running. |
| App reopen | Connect → `listSessions` → reconcile store → `attach` each → ANSI snapshot → renderer xterm |
| Daemon crash | Cold restore from scrollback.bin |
| Kill | Electron → daemon `kill` → tree-kill PTY subprocess |

## Initial Command Handling

`createOrAttach` accepts optional `initialCommand`. Daemon listens for first PTY data event, then writes command to PTY. All server-side.

## Cold Restore (History Manager)

- Electron-side, not in daemon
- Appends all `data` events to `~/.orchestra/terminal-history/{workspaceId}/{sessionId}/scrollback.bin`
- Writes `meta.json`: cwd, cols, rows, startedAt, endedAt
- Max 5MB per session
- On daemon crash: replay raw scrollback (text only, no running processes)

## File Structure

**New files:**
- `src/daemon/daemon.ts` — daemon entry point, Unix socket server, TerminalHost
- `src/daemon/session.ts` — Session class with emulator + subprocess handle
- `src/daemon/headless-emulator.ts` — HeadlessEmulator wrapper (@xterm/headless)
- `src/daemon/pty-subprocess.ts` — PTY subprocess entry point (node-pty)
- `src/daemon/protocol.ts` — shared types, binary framing helpers, NDJSON
- `src/main/daemon-launcher.ts` — spawn/find daemon process
- `src/main/daemon-client.ts` — connect to daemon, expose API to main process
- `src/main/history-manager.ts` — cold restore scrollback files

**Replace:**
- `src/main/pty-manager.ts` → removed, replaced by daemon-client

**Modify:**
- `src/main/index.ts` — use daemon-client instead of pty-manager
- `src/shared/types.ts` — add daemon protocol types

**Unchanged:**
- All renderer code (xterm UI, Sidebar, NavBar, TerminalArea, useTerminal)
- Preload (IPC bridge stays the same)
- Store, settings, color utils

## Deferred

- Auth token for daemon socket (single-user desktop app, Unix permissions suffice for now)
