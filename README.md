# Orchestra

A desktop terminal orchestrator for managing multiple AI coding agents side by side. Run Claude Code, OpenAI Codex, and other terminal-based tools across color-coded workspaces with automatic agent detection and a unified monitoring dashboard — and pick them up from your phone over Tailscale, with no cloud in between.

## Features

- **Multi-workspace management** — organize terminal sessions into color-coded workspaces
- **AI agent detection** — automatically detects when Claude Code or OpenAI Codex is running in a terminal
- **Maestro Mode** — full-screen multi-pane dashboard to monitor and interact with all active agents at once, with grid navigation via arrow keys
- **Session persistence** — workspaces and terminal scrollback survive app restarts (tmux-like)
- **Git worktree scanning** — discover and import git worktrees into workspaces
- **Automation scheduler** — define custom actions with cron scheduling, track runs, and debug with an overlay
- **Diff viewer** — built-in side-by-side diff panel for reviewing changes
- **Customizable keybindings** — remap shortcuts to your preference
- **Phone access** — mirror your sessions to a phone over Tailscale; hit
  **Connect to mobile** in the top bar for a QR code. No account, no server to host.

## Requirements

- **macOS** (primary target; Windows/Linux builds exist but are less tested)
- [Bun](https://bun.sh) v1.3+ (also drives the workspace; Node 20+ is pulled in for Electron tooling)
- [Tailscale](https://tailscale.com/download) on the Mac and on the phone — only for phone access

## Quick start

**Install a release (easiest):** download the `.dmg` for your Mac (arm64 for
Apple Silicon, x64 for Intel) from the
[latest release](https://github.com/Thiagoxp95/orchestra/releases/latest),
drag Orchestra to Applications, and open it. The app updates itself from
then on.

**Or run from source:**

```bash
bun install
cd apps/desktop && bun run dev
```

That starts electron-vite with hot reload for the renderer. The app is fully
usable with just this; phone access is optional and off until you set it up.

### Phone setup (once)

1. Sign in to Tailscale on the Mac and the phone. In the Tailscale admin
   console, enable **MagicDNS** and **HTTPS certificates**.
2. Publish the desktop's local server on your tailnet:
   ```bash
   python3 infra/tailscale/setup.py
   ```
   This runs `tailscale serve --bg --https=8445 http://127.0.0.1:13000` after a
   few safety checks, and prints your phone URL. Serve remembers it across
   reboots. `--status` and `--uninstall` are available.
3. In the desktop app, click **Connect to mobile** at the right end of the
   top bar and scan the QR code with the phone. Add it to the home screen for
   the PWA experience.

Details, ports and troubleshooting: [infra/tailscale/README.md](infra/tailscale/README.md).

The phone works while the desktop app is running on the Mac; there is no
background service. Being on your tailnet **is** the login — there is no
password, so control who gets in with Tailscale ACLs.

## Architecture

Everything the phone needs is one loopback server inside the Electron main
process (`apps/desktop/src/main/local-server/`):

```
                 ┌──────────────────────── Orchestra.app (Electron) ─────────────────────────┐
                 │                                                                           │
                 │  main process                                                             │
                 │   ├─ node-pty sessions, daemon, automations, agent detection               │
                 │   └─ local server  http://127.0.0.1:13000   (ORCHESTRA_LOCAL_WEB_PORT)      │
                 │        GET  /*            static web export  (apps/web/out, bundled)       │
                 │        WS   /api/sync     reactive reads + all writes (state mirror)       │
                 │        WS   /host /viewer terminal byte stream                             │
                 │        POST /api/upload   pasted images                                    │
                 │        GET  /api/config   runtime settings (push public key)               │
                 │        POST /webhook/:tok inbound webhooks → automations                   │
                 └─────────────────────────────────▲─────────────────────────────────────────┘
                                                   │ loopback only
                                    Tailscale Serve  https://<mac>.<tailnet>.ts.net:8445
                                                   │ (ORCHESTRA_MOBILE_WEB_PORT)
                                                   ▼
                                               📱 phone (PWA), same tailnet
```

- The web app (`apps/web`) is a Next.js **static export**; it resolves every
  URL from its own origin, so it is the same artifact on the Mac and on the
  phone and can never version-skew from the desktop.
- State is held in memory plus a small durable store in the app's user-data
  directory. There is no database to run.
- Push notifications use Web Push; the VAPID key pair is generated by the app
  on first run and stored locally. Nothing to configure.
- Webhooks (`/webhook/<token>`) are reachable only from your tailnet. Cloud
  services (Linear, GitHub…) cannot call them unless you expose that route
  yourself, e.g. with Tailscale Funnel — see the Tailscale README caveat.

## Configuration (all optional)

Orchestra runs with zero configuration.

- **OpenRouter key** (optional): model-written notification titles and
  webhook filters. Set it in the app under Settings → OpenRouter; it is stored
  encrypted with the OS keychain. Without it, titles fall back to a heuristic
  and webhook filters pass everything. Exporting `OPENROUTER_API_KEY` in the
  shell that launches Orchestra also works.

Environment variables the desktop reads at runtime, from the shell that
launches it (the `.env` files are build-time only):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ORCHESTRA_LOCAL_WEB_PORT` | `13000` | Loopback port of the local server |
| `ORCHESTRA_MOBILE_WEB_PORT` | `8445` | Tailscale Serve port shown in the QR code (must match `setup.py`) |

Build-time only (`apps/desktop/.env.local`, gitignored):

| Variable | Purpose |
|----------|---------|
| `MAIN_VITE_UPDATER_GH_TOKEN` | Only if your fork's repo is private: a read token so the auto-updater can reach its releases |

## Scripts

| Command | Where | Description |
|---------|-------|-------------|
| `bun run dev` | `apps/desktop` | Start the desktop app in development mode |
| `bun run build` | `apps/web` | Static-export the phone client to `apps/web/out` |
| `bun run build:mac` | `apps/desktop` | Package a signed macOS app (`build:win`, `build:linux` likewise) into `apps/desktop/dist/` |
| `bun run build` | root | Build every package via Turborepo |
| `bun run lint` / `bun run typecheck` | root | oxlint / tsgo across the workspace |
| `bun run release` | `apps/desktop` | Bump the version, commit and push to `main` (see Releases) |

## Building a release

The packaged desktop app **includes the web app**, so build the web export
first — `electron-builder.yml` copies `apps/web/out` into the app's resources:

```bash
cd apps/web && bun run build
cd ../desktop && bun run build:mac
```

`bun run build:mac` runs `electron-vite build` then `electron-builder --mac`.
Unsigned local builds work without any Apple credentials; signing and
notarization kick in when `CSC_LINK` / `APPLE_API_*` are present.

### Releases from GitHub Actions

`.github/workflows/auto-release.yml` watches `apps/desktop/package.json` on
`main`: bumping its version (`bun run release`, `release:minor`, `release:major`
from `apps/desktop`) triggers `release.yml`, which builds the web export, builds
and notarizes the app, and publishes a GitHub Release with the
`latest-mac.yml` metadata that electron-updater reads.

The workflows target a **self-hosted macOS runner** (`runs-on: [self-hosted,
macOS, ARM64]`); switch to `macos-14` if you don't register one. Secrets used:
`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER` (signing/notarization) and, only for private forks,
`UPDATER_GH_TOKEN`.

**Forks change one field.** Point `repository` in `apps/desktop/package.json`
at your fork. electron-builder reads the GitHub `owner`/`repo` from it (the
workflow already publishes to `${{ github.repository }}`), so your build
auto-updates from your fork's own Releases.

## Project structure

```
orchestra/
├── apps/
│   ├── desktop/               # Electron application — the whole product
│   │   ├── src/
│   │   │   ├── main/          # Main process (PTY manager, process monitor, persistence, automation)
│   │   │   │   └── local-server/  # The loopback HTTP/WS server the phone talks to
│   │   │   ├── daemon/        # Persistent daemon (session management, history)
│   │   │   ├── preload/       # IPC bridge (contextIsolation)
│   │   │   └── renderer/src/  # React UI
│   │   ├── electron-builder.yml
│   │   └── electron.vite.config.ts
│   └── web/                   # Next.js PWA — the phone client, static export bundled into the desktop app
├── infra/tailscale/           # setup.py: publish the local server on your tailnet
├── docs/                      # Design documents and implementation plans
├── turbo.json                 # Turborepo configuration
└── package.json               # Root workspace config
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 35, electron-vite |
| UI | React (18 desktop / 19 web), Tailwind CSS v4 |
| Terminal | xterm.js, node-pty |
| State | Zustand |
| Persistence | electron-store |
| Scheduling | croner |
| Phone transport | Node `http` + `ws`, Tailscale Serve |
| Build | Bun, Turborepo, oxlint, tsgo |

## How it works

1. **Workspaces** group related terminal sessions together. Each workspace has a name and accent color.
2. **Sessions** are real pseudo-terminals (PTY) managed by `node-pty` in the main process. Scrollback is serialized and restored on restart.
3. The **process monitor** polls child processes every ~2 seconds to detect AI tools (Claude Code, Codex) and surfaces their status in the UI.
4. **Maestro Mode** renders all active agent sessions in a responsive grid, letting you monitor and interact with every agent from a single view.
5. **Automations** let you schedule shell commands on a cron schedule or fire them from inbound webhooks, with run history and a debug overlay.
6. The **local server** mirrors session state to the phone over one WebSocket and streams terminal bytes over another; the phone's writes come back the same way.

## Development notes

- Shared types live in `apps/desktop/src/shared/types.ts`; the phone/desktop wire protocol in `apps/desktop/src/shared/sync-protocol.ts`.
- IPC is typed through `src/preload/index.ts` and `src/renderer/src/env.d.ts`.
- electron-store v11 is ESM-only and excluded from `externalizeDepsPlugin` in the vite config.
- Web client dev loop: see [apps/web/README.md](apps/web/README.md).

## License

MIT
