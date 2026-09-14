#!/usr/bin/env python3
"""Publish the Orchestra desktop app to your phone over Tailscale Serve.

The Orchestra desktop app runs one loopback HTTP/WebSocket server (default
127.0.0.1:13000) that serves the phone client, its sync socket, the terminal
stream, uploads and webhooks. This script only tells Tailscale Serve to front
that port with HTTPS on your tailnet. There is nothing to install, no launch
agent, no secret: the desktop app must simply be running for the phone to work.

    python3 infra/tailscale/setup.py                 # publish (idempotent)
    python3 infra/tailscale/setup.py --status        # show what Serve does for us
    python3 infra/tailscale/setup.py --uninstall     # remove our Serve route only
    python3 infra/tailscale/setup.py --remove-legacy # drop the pre-1.26 launch agents

Ports come from the same environment variables the desktop reads:
    ORCHESTRA_MOBILE_WEB_PORT  HTTPS port on the tailnet   (default 8445)
    ORCHESTRA_LOCAL_WEB_PORT   loopback port of the desktop (default 13000)

Python 3 standard library only; no third-party packages.
"""
import json
import os
import shutil
import subprocess
import sys

MOBILE_PORT = int(os.environ.get('ORCHESTRA_MOBILE_WEB_PORT') or 8445)
LOCAL_PORT = int(os.environ.get('ORCHESTRA_LOCAL_WEB_PORT') or 13000)
TARGET = f'http://127.0.0.1:{LOCAL_PORT}'

# `tailscale` is usually not on PATH on macOS when installed from the App Store.
TAILSCALE_CANDIDATES = [
    shutil.which('tailscale'),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
]


def fail(message):
    print(f'error: {message}', file=sys.stderr)
    sys.exit(1)


def find_tailscale():
    for candidate in TAILSCALE_CANDIDATES:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    fail('tailscale CLI not found. Install Tailscale from https://tailscale.com/download and sign in.')


def tailscale_json(binary, *args):
    result = subprocess.run([binary, *args, '--json'], capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"`tailscale {' '.join(args)}` failed: {result.stderr.strip() or result.stdout.strip()}")
    try:
        return json.loads(result.stdout)
    except ValueError:
        fail(f"`tailscale {' '.join(args)}` did not return JSON; is this the Tailscale CLI?")


def magicdns_name(binary):
    """This machine's MagicDNS name, or exit with a reason the user can act on."""
    status = tailscale_json(binary, 'status')
    if status.get('BackendState') != 'Running':
        fail(f"Tailscale is not connected (state: {status.get('BackendState')}). Open Tailscale and sign in.")
    name = (status.get('Self') or {}).get('DNSName', '').rstrip('.')
    if not name.endswith('.ts.net'):
        fail('MagicDNS is off. Enable it in the Tailscale admin console (DNS tab); Serve needs it for an HTTPS certificate.')
    return name


def our_route(binary, name):
    """The handler Serve currently has on our HTTPS port, if any."""
    serve = tailscale_json(binary, 'serve', 'status')
    web = serve.get('Web') or {}
    handlers = (web.get(f'{name}:{MOBILE_PORT}') or {}).get('Handlers') or {}
    proxy = (handlers.get('/') or {}).get('Proxy')
    funnel = bool((serve.get('AllowFunnel') or {}).get(f'{name}:{MOBILE_PORT}'))
    return proxy, funnel


def phone_url(name):
    return f'https://{name}:{MOBILE_PORT}'


def cmd_install(binary, name):
    proxy, funnel = our_route(binary, name)
    if funnel:
        fail(f'Port {MOBILE_PORT} has Tailscale Funnel enabled (public internet). '
             f'Disable it first: tailscale funnel --https={MOBILE_PORT} off')
    if proxy and proxy != TARGET:
        fail(f'Tailscale port {MOBILE_PORT} already proxies {proxy}. Pick another port with '
             f'ORCHESTRA_MOBILE_WEB_PORT (set it for the desktop app too) or free that port.')
    if proxy == TARGET:
        print(f'Already published: {phone_url(name)} -> {TARGET}')
    else:
        subprocess.run([binary, 'serve', '--bg', f'--https={MOBILE_PORT}', TARGET], check=True)
        print(f'Published: {phone_url(name)} -> {TARGET}')
    print()
    print(f'Phone URL: {phone_url(name)}')
    print('Open it on any device in your tailnet, or click "Connect to mobile" in the')
    print('desktop footer for a QR code. The Orchestra desktop app must be running.')
    if not listening():
        print(f'note: nothing is listening on {TARGET} right now — start the desktop app.')
    warn_legacy()


def cmd_status(binary, name):
    proxy, funnel = our_route(binary, name)
    print(f'MagicDNS name : {name}')
    print(f'Phone URL     : {phone_url(name)}')
    print(f'Serve route   : {proxy or "(none — run setup.py to publish)"}')
    if proxy and proxy != TARGET:
        print(f'                expected {TARGET}; this port is used by something else')
    print(f'Funnel        : {"ENABLED (public!) — disable it" if funnel else "off"}')
    print(f'Desktop app   : {"listening" if listening() else "not listening"} on {TARGET}')
    warn_legacy()


def cmd_uninstall(binary, name):
    proxy, _ = our_route(binary, name)
    if proxy is None:
        print(f'No Serve route on port {MOBILE_PORT}; nothing to remove.')
        return
    if proxy != TARGET:
        fail(f'Port {MOBILE_PORT} proxies {proxy}, not Orchestra. Refusing to touch it.')
    # Per-port removal. Never `tailscale serve reset`: that wipes every route on
    # the machine, including ones that have nothing to do with Orchestra.
    subprocess.run([binary, 'serve', f'--https={MOBILE_PORT}', 'off'], check=True)
    print(f'Removed Serve route for port {MOBILE_PORT}.')


# Before 1.26 this script installed launch agents for a Convex backend, a
# terminal relay and a `next start` web server, and published each through
# its own Serve port. The web one holds the loopback port the desktop app now
# binds itself, so the app cannot come up while it is loaded.
LEGACY_LABELS = [
    'com.orchestra.private-web',
    'com.orchestra.private-relay',
    'com.orchestra.private-backend',
    'com.orchestra.private-backup',
]
LEGACY_SERVE_ROUTES = {8446: 'http://127.0.0.1:13210', 8447: 'http://127.0.0.1:18080', 8448: 'http://127.0.0.1:13211'}
LEGACY_STATE_DIR = '~/Library/Application Support/Orchestra/private-network'


def legacy_plists():
    agents = os.path.expanduser('~/Library/LaunchAgents')
    return [os.path.join(agents, f'{label}.plist') for label in LEGACY_LABELS
            if os.path.isfile(os.path.join(agents, f'{label}.plist'))]


def warn_legacy():
    if not legacy_plists():
        return
    print()
    print('note: launch agents from the previous Orchestra setup (Convex backend, relay,')
    print(f'      next.js web) are still installed. The web one occupies port {LOCAL_PORT}, so')
    print('      the desktop app cannot start its own server until they are removed:')
    print('        python3 infra/tailscale/setup.py --remove-legacy')


def cmd_remove_legacy():
    plists = legacy_plists()
    uid = os.getuid()
    for plist in plists:
        label = os.path.splitext(os.path.basename(plist))[0]
        # bootout is the modern verb; unload covers older macOS.
        done = subprocess.run(['launchctl', 'bootout', f'gui/{uid}/{label}'], capture_output=True)
        if done.returncode != 0:
            subprocess.run(['launchctl', 'unload', plist], capture_output=True)
        os.remove(plist)
        print(f'Removed launch agent {label}')
    # The extra Serve ports the old setup published, only where they still
    # point at the old services — anything else on those ports is not ours.
    binary = next((c for c in TAILSCALE_CANDIDATES if c and os.path.isfile(c)), None)
    removed_routes = 0
    if binary:
        serve = tailscale_json(binary, 'serve', 'status')
        web = serve.get('Web') or {}
        for port, target in LEGACY_SERVE_ROUTES.items():
            for host, entry in web.items():
                if not host.endswith(f':{port}'):
                    continue
                proxy = ((entry.get('Handlers') or {}).get('/') or {}).get('Proxy')
                if proxy == target:
                    subprocess.run([binary, 'serve', f'--https={port}', 'off'], check=True)
                    print(f'Removed Serve route {port} -> {target}')
                    removed_routes += 1
    if not plists and not removed_routes:
        print('No legacy launch agents or Serve routes found.')
        return
    print()
    print(f'The old services are gone. Their data stayed in {LEGACY_STATE_DIR}')
    print('in case you want it back; delete that folder to reclaim the space.')


def listening():
    import socket
    try:
        with socket.create_connection(('127.0.0.1', LOCAL_PORT), timeout=0.5):
            return True
    except OSError:
        return False


def main(argv):
    flags = set(argv)
    if flags - {'--status', '--uninstall', '--remove-legacy', '-h', '--help'}:
        fail(f'unknown argument(s): {" ".join(sorted(flags))}\n\n{__doc__}')
    if '-h' in flags or '--help' in flags:
        print(__doc__)
        return
    if '--remove-legacy' in flags:
        cmd_remove_legacy()
        return
    binary = find_tailscale()
    name = magicdns_name(binary)
    if '--status' in flags:
        cmd_status(binary, name)
    elif '--uninstall' in flags:
        cmd_uninstall(binary, name)
    else:
        cmd_install(binary, name)


if __name__ == '__main__':
    main(sys.argv[1:])
