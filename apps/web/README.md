# Orchestra web

The phone client: a Next.js PWA built as a **static export** and served by the
Orchestra desktop app. There is no web server of its own, no cloud backend and
no sign-in — the desktop's local server is the only thing it talks to, and
reaching that server already requires being on your tailnet
(see [infra/tailscale/README.md](../../infra/tailscale/README.md)).

## How it finds the desktop

Every URL is derived from `window.location` at runtime — there are no
`NEXT_PUBLIC_*` server/backend variables to set:

- `src/lib/sync/client.ts` opens the sync WebSocket at
  `ws(s)://<same host>/api/sync`.
- `src/lib/terminal-stream/connection.ts` opens the terminal stream at
  `ws(s)://<same host>/viewer`.
- Uploads go to `/api/upload`, runtime settings (push public key) to
  `/api/config`, all same-origin.

So whatever origin serves `out/` is the desktop it controls:
`http://127.0.0.1:13000` on the Mac itself, or
`https://<mac>.<tailnet>.ts.net:8445` from the phone through Tailscale Serve.

The only build-time value is `NEXT_PUBLIC_BUILD_ID`, set by `next.config.ts`
from `public/build-id.txt` (see below).

## Build

```sh
bun run build
```

runs `scripts/stamp-build-id.mjs` and then `next build` with `output: "export"`.
The result is `out/`, which the desktop serves:

- in development, straight from `apps/web/out` (the desktop resolves
  `../web/out` relative to `apps/desktop`);
- in a packaged app, from `Orchestra.app/Contents/Resources/web`, copied in by
  `extraResources` in `apps/desktop/electron-builder.yml`.

Build the web app **before** packaging the desktop app, or the packaged app has
no phone client. The release workflow does this.

`out/` and `public/build-id.txt` are gitignored; both are regenerated on every
build. The build id is inlined into the bundle and also served as
`/build-id.txt`, which is how a long-lived phone page notices it is running
stale code (`src/lib/build-freshness.ts`) and offers to reload.

## Development

The fastest loop against real data is: run the desktop app in dev
(`cd apps/desktop && bun run dev`), then in this directory

```sh
bun run build
```

and reload `http://127.0.0.1:13000` (or the phone URL). The desktop serves
`out/` as-is, so a rebuild is all it takes.

`bun run dev` (`next dev` on `http://localhost:3000`) is useful for UI-only
work with hot reload, but because URLs are same-origin the page will try to
open `ws://localhost:3000/api/sync`, which nothing answers — you get the
"reconnecting" state and no sessions. There is deliberately no override knob
for the origin; the app is only ever served by the desktop.

Tests: `bun run test` (vitest). Typecheck: `bun run typecheck`.
