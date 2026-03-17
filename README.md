# Orchestra

A desktop terminal orchestrator for managing multiple AI coding agents side by side. Run Claude Code, OpenAI Codex, and other terminal-based tools across color-coded workspaces with automatic agent detection and a unified monitoring dashboard.

## Features

- **Multi-workspace management** — organize terminal sessions into color-coded workspaces
- **AI agent detection** — automatically detects when Claude Code or OpenAI Codex is running in a terminal
- **Maestro Mode** — full-screen multi-pane dashboard to monitor and interact with all active agents at once, with grid navigation via arrow keys
- **Session persistence** — workspaces and terminal scrollback survive app restarts (tmux-like)
- **Git worktree scanning** — discover and import git worktrees into workspaces
- **Automation scheduler** — define custom actions with cron scheduling, track runs, and debug with an overlay
- **Diff viewer** — built-in side-by-side diff panel for reviewing changes
- **Customizable keybindings** — remap shortcuts to your preference

## Prerequisites

- **macOS** (primary target; Windows/Linux builds available but less tested)
- [Bun](https://bun.sh) v1.3+
- [Node.js](https://nodejs.org) v20+ (required by Electron)

## Getting Started

### Install dependencies

```bash
bun install
```

### Run in development mode

```bash
bun run dev
```

This starts electron-vite in dev mode with hot-reload for the renderer process.

### Build for production

```bash
# macOS
bun run build:mac

# Windows
bun run build:win

# Linux
bun run build:linux
```

Built artifacts are output to `apps/desktop/dist/`.

### Other scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start the app in development mode |
| `bun run build` | Build all packages (via Turborepo) |
| `bun run lint` | Lint with oxlint |
| `bun run typecheck` | Type-check all packages |

## Project Structure

```
orchestra/
├── apps/
│   └── desktop/               # Electron application
│       ├── src/
│       │   ├── main/          # Main process (PTY manager, process monitor, persistence, automation)
│       │   ├── daemon/        # Persistent daemon (session management, history)
│       │   ├── preload/       # IPC bridge (contextIsolation)
│       │   └── renderer/src/  # React UI
│       │       ├── components/  # UI components (Sidebar, Terminal, Maestro, Diff, etc.)
│       │       ├── hooks/       # React hooks (useTerminal, useProcessStatus, useAutomations, etc.)
│       │       └── store/       # Zustand state management
│       └── electron.vite.config.ts
├── docs/plans/                # Design documents and implementation plans
├── turbo.json                 # Turborepo configuration
└── package.json               # Root workspace config
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 35, electron-vite |
| UI | React 19, Tailwind CSS v4 |
| Terminal | xterm.js, node-pty |
| State | Zustand |
| Persistence | electron-store |
| Scheduling | croner |
| Icons | hugeicons-react |
| Build | Bun, Turborepo, oxlint, tsgo |

## How It Works

1. **Workspaces** group related terminal sessions together. Each workspace has a name and accent color.
2. **Sessions** are real pseudo-terminals (PTY) managed by `node-pty` in the main process. Scrollback is serialized and restored on restart.
3. The **process monitor** polls child processes every ~2 seconds to detect AI tools (Claude Code, Codex) and surfaces their status in the UI.
4. **Maestro Mode** renders all active agent sessions in a responsive grid, letting you monitor and interact with every agent from a single view.
5. **Automations** let you schedule shell commands on a cron schedule, with run history and a debug overlay.

## Development

The project uses a Turborepo monorepo with a single app at `apps/desktop`. The renderer uses Vite with React and Tailwind CSS v4 (via `@tailwindcss/vite`).

Key conventions:
- Shared types live in `src/shared/types.ts`
- IPC is typed through `src/preload/index.ts` and `src/renderer/src/env.d.ts`
- electron-store v11 is ESM-only and excluded from `externalizeDepsPlugin` in the vite config

## License

MIT
