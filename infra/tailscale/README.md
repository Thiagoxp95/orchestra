# Private, local Orchestra

The desktop, Convex backend, phone app, and terminal relay run on the Mac. The
phone connects through Tailscale Serve. Devices must be in the same tailnet;
they do not need the same Wi-Fi or physical subnet. Tailscale access rules apply.

| Endpoint on the Mac's `*.ts.net` name | Loopback service | Purpose |
| --- | --- | --- |
| HTTPS 8445 | 127.0.0.1:13000 | Phone app |
| HTTPS 8446 | 127.0.0.1:13210 | Convex API, sync and file storage |
| WSS 8447 | 127.0.0.1:18080 | Terminal stream |
| HTTPS 8448 | 127.0.0.1:13211 | HTTP actions |

Services bind only to loopback. Serve makes them accessible inside the tailnet;
Funnel must remain disabled. Setup preserves existing Serve routes on other ports.
The terminal relay checks the exact phone origin and existing login token. There
is no public relay fallback. Internet services such as Linear and GitHub cannot
call private webhook URLs; their public webhook delivery requires a separate
explicit design. Outbound integrations and paid model API calls still use their
providers.

## Runtime and data

`~/Library/Application Support/Orchestra/private-network/` holds the native backend
binary, logs, configuration, and `backend/data/`. The latter contains the SQLite
database, file storage, and instance credentials. It is outside the checkout and
must survive app updates. Never start another backend against this same directory.

The native Apple Silicon backend matches the former server exactly:
`precompiled-2026-08-10-c0cb7ae`, revision
`c0cb7ae17f54e14846c243c5332a8a5e6d0e19d4`. The official
`convex-local-backend-aarch64-apple-darwin.zip` has SHA-256
`95159c96cf9348fc49d94a1fd5bdffb49fe27a5e0442f8787939b4d871ec0b5e`.
Keep upgrades explicit and take a backup first. Docker and Fly CLI are not runtime
requirements. `backend.py` refuses to start without restored data and credentials.

## Install / update

Prerequisites: connected Tailscale with HTTPS enabled, Python 3, Node, Bun,
repository dependencies, the backend binary and restored data above, and
`apps/desktop/.env.local` containing `MAIN_VITE_DEVICE_SECRET`.

```sh
python3 infra/tailscale/setup.py
```

Setup discovers the Mac's hostname, builds the phone app into `.next-private`,
installs service and backup launch agents, and configures Serve. It refuses conflicting
ports or public Funnel on its ports. Agents start at login and restart failed
processes. Serve persists its routes. The Mac must remain awake and logged in;
phone access is unavailable while it is asleep or offline.

Desktop build configuration:

- `MAIN_VITE_CONVEX_CLOUD_URL` and `RENDERER_VITE_CONVEX_URL`: `http://127.0.0.1:13210`.
- `MAIN_VITE_CONVEX_SITE_URL`: `https://<mac-name>.ts.net:8448`.
- Terminal host default: `ws://127.0.0.1:18080`.

Backend CLI configuration in `apps/backend/.env.local` uses
`CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210` and the preserved admin key.
Use `convex deploy` for reviewed functions; `convex dev` writes live code on every
edit and should not target this database.

## Recovery and backups

Established terminal connections retry immediately after a drop. Failed attempts
back off from 500 ms to at most 10 seconds. Heartbeats run every five seconds with
a three-second deadline. Foreground, online, and desktop wake events bypass
backoff. Output resumes from the last applied cursor; keystrokes are not queued
or replayed. A disconnected/sleeping phone cannot reconnect until its OS resumes
network access.

```sh
tailscale serve status
curl --fail http://127.0.0.1:13210/version
curl --fail http://127.0.0.1:18080/health
launchctl print gui/$(id -u)/com.orchestra.private-backend
bash infra/convex/backup.sh
python3 -m unittest discover -s infra/tailscale -p 'test_*.py'
bun run --cwd apps/terminal-relay test
bun run --cwd apps/web test src/lib/terminal-stream/stream.test.ts src/lib/convex-recovery.test.ts
```

The backup script exports current documents and stored files, retaining ten
completed archives. The `com.orchestra.private-backup` agent runs at 03:30 local
time and also saves instance credentials and backend environment settings under
`private-network/backups/`; logical exports alone do not contain deployment secrets.
A backup on this Mac alone does not protect against losing the Mac.

Services are `com.orchestra.private-web`, `com.orchestra.private-relay`, and
`com.orchestra.private-backend`. To remove one, boot it out with `launchctl bootout`,
remove its plist from `~/Library/LaunchAgents`, and disable only its Serve port
with `tailscale serve --https=PORT off`. Never use `serve reset`.

The old Fly config is retained only for disaster recovery. Do not deploy it during
normal local operation: it would create a separate cloud database. Both retired Fly apps and their associated resources were deleted on September
12 after verification and explicit user approval. Their original volumes and
addresses are no longer available; recovery requires the retained local backups.
