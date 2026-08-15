# Self-hosted Convex

Orchestra's backend used to run on Convex Cloud (`fearless-pika-904`). It now runs
on a single Fly machine in `yyz` — same functions, same schema, same client
library, no code changes. Only the address moved.

Convex Cloud's usage-based plan bills Database I/O, and this team's two projects
together were walking toward the $60/month threshold that *disables* deployments.
A fixed-cost machine is the right shape for workloads that poll.

## The address change

Convex Cloud gave us two hostnames. Self-hosted gives us two **ports** on one host:

| Was | Is | Carries |
|---|---|---|
| `fearless-pika-904.convex.cloud` | `https://orchestra-convex.fly.dev` | API, websocket sync |
| `fearless-pika-904.convex.site` | `https://orchestra-convex.fly.dev:3211` | HTTP actions — `/webhook/*`, `/api/summarize*` |

**The `:3211` is load-bearing.** `webhook-listener.ts` builds Linear/GitHub
webhook URLs from `MAIN_VITE_CONVEX_SITE_URL`; drop the port and those URLs point
at the API port and 404. It is also why this app needs a *dedicated* IPv4
($2/mo): Fly's free shared IPv4 only serves ports 80 and 443.

Consumers of these URLs:

- `apps/web/.env.production` — `NEXT_PUBLIC_CONVEX_URL`
- `apps/desktop/.env` and `.env.local` — `MAIN_VITE_CONVEX_CLOUD_URL`,
  `MAIN_VITE_CONVEX_SITE_URL`, `RENDERER_VITE_CONVEX_URL`

No webhooks were registered at migration time, so nothing needed re-pointing in
Linear. Any webhook created *before* the move would still carry a
`fearless-pika-904.convex.site` URL and must be recreated.

## Operating it

Credentials live in `apps/backend/.env.local` (gitignored), so the CLI works from
that directory with no extra env:

```bash
cd apps/backend
bunx convex deploy       # push functions
bunx convex env list     # deployment env vars
bunx convex data issues  # inspect a table
bunx convex logs         # tail function logs
```

**Never run `convex dev` against it** — dev hot-pushes every local edit straight
to production. Use `convex dev --local` for local work.

Regenerate the admin key any time — it derives from `INSTANCE_NAME` plus the
`INSTANCE_SECRET` Fly secret, so it is stable across deploys:

```bash
fly ssh console -a orchestra-convex -C "./generate_admin_key.sh"
```

## Things that will bite you

**One machine, forever.** The database is SQLite on the mounted volume. Two
machines would mean two divergent databases, which is why `auto_stop_machines` is
off and the app is never scaled out. That also means the machine must stay awake:
crons only fire while it is running.

**Verify the volume is actually mounted after any infra change.** The sibling
GoGrow app shipped without a `[mounts]` block and nothing complained: the backend
started, `/version` returned 200, health checks passed, and a full snapshot
imported — all onto the machine's ephemeral overlay. The first restart destroyed
the entire database, functions included. `df -h /convex/data` must show `/dev/vd*`
and `fly volumes list` must show an `ATTACHED VM`.

Related: never resize with `fly machine update --vm-size`. It rebuilds the machine
from flags and drops the mount. Edit `[[vm]]` here and run `fly deploy`.

**Backups are ours now.** Two layers, and they fail differently — Fly's automatic
daily volume snapshots (5-day retention, block-level, Fly-only) and
`infra/convex/backup.sh`, which writes a portable zip restorable into any Convex
deployment. Run the script before schema changes.
