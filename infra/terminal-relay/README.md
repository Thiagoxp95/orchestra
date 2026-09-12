# Terminal relay

A single stateless Fly machine routes the desktop's outbound `/host` WebSocket to authorized browser `/viewer` connections. Terminal bytes stay out of Convex. The daemon remains authoritative; relay restarts cause offset-based reconnects.

The service intentionally runs **one machine**: its routing table is process-local. Do not scale horizontally until host discovery/routing is implemented. This is separate from the Convex machine and its persistent database volume.

## Configuration

- `DEVICE_SECRET`: same private secret as desktop and Convex, supplied with Fly secrets, never in a URL.
- `ALLOWED_ORIGINS`: comma-separated exact production web origins. Preview deployments require explicit addition.
- `CONVEX_URL`: production Convex API endpoint.
- Desktop `ORCHESTRA_TERMINAL_RELAY_URL` optionally overrides the default relay URL.

From the repository root:

```sh
flyctl deploy --config infra/terminal-relay/fly.toml --ha=false
curl --fail https://orchestra-terminal-relay.fly.dev/health
```

`/health` returns protocol version, whether a desktop host is connected, and viewer count. It contains no session identifiers or terminal content. Authentication is checked on connect and every minute; socket keepalive runs every 15 seconds. New viewers opt into waiting for the desktop on the existing connection and attach immediately when the host authenticates. The relay advertises application heartbeat support so browsers can detect half-open connections; older clients and relays remain compatible. Desktop and browser heartbeat probes run every 10 seconds with a 5-second response deadline. Desktop connection/authentication attempts have a 5-second deadline and restart immediately on wake. Browser foreground recovery preserves the applied terminal cursor and never replays terminal input. Maximum 32 viewers, 64 KiB unacknowledged stream data per viewer, 8 MiB total socket queue bounds, and a 4 MiB checkpoint limit. A slow viewer reconnects to a checkpoint if its daemon's 8 MiB retained suffix expires.

The browser uses the legacy transport only when the mirrored desktop lacks stream support or a preserved older daemon explicitly reports unsupported. Existing PTYs are never killed to activate a new daemon. The new daemon activates after the existing daemon is safely stopped through the application's normal lifecycle; running legacy sessions remain usable during rollout.

## Deployment order and rollback

1. Deploy the additive `terminalStream:authorize` Convex query.
2. Deploy and health-check the relay.
3. Deploy the compatible web client.
4. Publish the desktop release that advertises terminal stream support.

For rollback, restore the previous desktop/web release together. Do not attach old and new output paths to the same xterm instance. Relay restart alone is safe: clients resume from applied cursors. Never stop or replace `orchestra-convex` to operate this relay.

## Validation

`bun run --cwd apps/terminal-relay test` exercises real sockets and authentication/routing. `bun run --cwd apps/terminal-relay test` exercises seed acknowledgements, independent delivery windows, per-session ownership, stale-input rejection and old-daemon compatibility.
