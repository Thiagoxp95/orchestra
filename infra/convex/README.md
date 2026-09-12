# Local Convex backend

Orchestra runs the open-source Convex backend directly on the Mac, with private
phone access through Tailscale. See [setup, storage, and recovery](../tailscale/README.md).
The database API listens at `http://127.0.0.1:13210`; HTTP actions listen at
`http://127.0.0.1:13211`. The same functions, schema, document IDs, authentication,
and client library are retained. No Convex Cloud subscription is needed to run it.

Backend CLI credentials live in `apps/backend/.env.local` (gitignored):

```sh
cd apps/backend
bunx convex deploy
bunx convex logs
```

Take portable backups with `infra/convex/backup.sh`, which includes file storage.
Do not run `convex dev` against the live database: it pushes every edit immediately.

`fly.toml` records the former cloud deployment for recovery only. The September 12
migration exposed its 4 GB startup memory limit while loading a 4.3 GB database;
restoring the original machine configuration did not resolve the memory failure.
The migration preserves verified local database/storage/credentials backups.
After local verification and explicit user approval, both retired Fly apps and
their associated resources were deleted on September 12. Recovery now uses the
local backups; the original Fly volume is no longer available.
