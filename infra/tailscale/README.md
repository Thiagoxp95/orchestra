# Phone access over Tailscale

Orchestra puts your terminal sessions on a phone without any cloud service.
The desktop app runs one loopback server, and [Tailscale Serve](https://tailscale.com/kb/1312/serve)
publishes it inside your tailnet with a real HTTPS certificate:

```
phone ──HTTPS 8445──▶ Tailscale Serve ──▶ 127.0.0.1:13000 (Orchestra desktop app)
```

| Default | Environment variable (read by the desktop app and `setup.py`) |
| --- | --- |
| Tailnet HTTPS port `8445` | `ORCHESTRA_MOBILE_WEB_PORT` |
| Loopback port `13000` | `ORCHESTRA_LOCAL_WEB_PORT` |

Everything the phone uses lives on that one port: the static web app, the
`/api/sync` WebSocket, the terminal stream (`/host`, `/viewer`), image uploads
(`/api/upload`), `/api/config` and inbound webhooks (`/webhook/<token>`).
The server binds only to loopback; Serve is the only way in. Funnel must stay off.

**The desktop app must be running.** There is no background service: the
server lives inside the Electron process, so the phone works exactly while
Orchestra is open on the Mac (asleep or quit means offline).

## There is no sign-in

Membership of the tailnet is the only credential. Nothing asks for an email,
password or token. Anyone you add to your tailnet — or any device you approve —
can drive your terminals, so scope access with
[Tailscale ACLs](https://tailscale.com/kb/1018/acls) rather than expecting an
application-level login.

## Setup (once per Mac)

Prerequisites: Tailscale installed and signed in on the Mac and on the phone,
with **MagicDNS** and **HTTPS certificates** enabled for the tailnet (Tailscale
admin console → DNS). Python 3 (ships with macOS). Nothing else.

```sh
python3 infra/tailscale/setup.py
```

It checks Tailscale is connected with a MagicDNS name, refuses to clobber a
Serve route that belongs to something else, refuses if Funnel is on for the
port, then runs the equivalent of:

```sh
tailscale serve --bg --https=8445 http://127.0.0.1:13000
```

and prints the phone URL (`https://<mac-name>.<tailnet>.ts.net:8445`). Serve
persists the route across reboots, so this is a one-time step. Re-running is
harmless.

Then, with the desktop app open, click **Connect to mobile** at the right
end of the top bar and scan the QR code. The button resolves the Mac's MagicDNS name at
click time and warns when Tailscale is down or nothing is listening on the
local port.

Other commands:

```sh
python3 infra/tailscale/setup.py --status     # route, funnel, is the app listening
python3 infra/tailscale/setup.py --uninstall  # remove only Orchestra's route
```

To use different ports, export `ORCHESTRA_MOBILE_WEB_PORT` / `ORCHESTRA_LOCAL_WEB_PORT`
for both the script and the desktop app.

## Webhooks

`POST https://<mac-name>.<tailnet>.ts.net:8445/webhook/<token>` triggers the
automation bound to that token. Because the URL is only reachable from inside
your tailnet, **internet services such as Linear or GitHub cannot deliver to
it**. If you need cloud-originated webhooks you have to front the endpoint
yourself — for example
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on a *separate* path
or port, or any tunnel you trust — understanding that this exposes that route
to the public internet. Orchestra does not set this up for you.

## Troubleshooting

```sh
tailscale status                     # BackendState must be Running, DNSName must end in .ts.net
tailscale serve status               # expect 8445 -> http://127.0.0.1:13000
curl -si http://127.0.0.1:13000/     # 200 from the desktop app's static handler
curl -si http://127.0.0.1:13000/api/config
```

- *"The app's local server is not answering"* in the QR popover: start the
  desktop app. If it is running, something else may hold port 13000 — see
  "Upgrading from the Convex setup" below.
- Phone gets a certificate error: HTTPS certificates are not enabled for the
  tailnet, or MagicDNS is off.
- Phone times out: the phone is not on the tailnet (check the Tailscale app),
  or an ACL blocks it.
- The phone app looks stale after updating the desktop: the page compares its
  baked-in build id against `/build-id.txt` and offers to reload; a hard reload
  also works. The web app ships inside the desktop app, so they cannot skew.

## Upgrading from the Convex setup

Before 1.26 this script installed launch agents for a Convex backend, a
terminal relay and a `next start` web server, each on its own Serve port. The
web one still holds port 13000, so the new desktop app cannot start its server
until they are gone:

```sh
python3 infra/tailscale/setup.py --remove-legacy
```

That unloads and deletes the `com.orchestra.private-*` launch agents and turns
off their Serve ports (8446–8448). Their data stays in
`~/Library/Application Support/Orchestra/private-network` until you delete it.
The `setup.py --status` output warns while they are still installed.
