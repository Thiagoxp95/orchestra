#!/usr/bin/env python3
"""Build and supervise Orchestra's private phone services on the current Mac."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = Path.home() / 'Library/Application Support/Orchestra/private-network'
AGENTS = Path.home() / 'Library/LaunchAgents'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def install(label, arguments, env=None, cwd=ROOT, schedule=None):
    path = AGENTS / f'{label}.plist'
    config = {
        'Label': label, 'ProgramArguments': arguments,
        'WorkingDirectory': str(cwd), 'RunAtLoad': True, 'KeepAlive': True,
        'ThrottleInterval': 2, 'ProcessType': 'Background',
        'EnvironmentVariables': {'PATH': os.environ['PATH'], **(env or {})},
        'StandardOutPath': str(STATE / f'{label}.log'),
        'StandardErrorPath': str(STATE / f'{label}.log'),
    }
    if schedule:
        config.update(RunAtLoad=False, KeepAlive=False, StartCalendarInterval=schedule)
    subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], capture_output=True)
    with path.open('wb') as file:
        plistlib.dump(config, file)
    path.chmod(0o600)
    for attempt in range(30):
        result = subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], capture_output=True, text=True)
        if result.returncode == 0:
            break
        if attempt == 29:
            raise RuntimeError(result.stderr)
        time.sleep(0.1)  # launchd may still be removing the old job after bootout.


def main():
    if os.uname().sysname != 'Darwin':
        raise SystemExit('This installer manages macOS launch agents.')
    binaries = {name: shutil.which(name) for name in ['tailscale', 'bun', 'node', 'python3']}
    if not all(binaries.values()):
        raise SystemExit('Install Tailscale, Python 3, Bun and Node before setup.')
    status = json.loads(run(binaries['tailscale'], 'status', '--json', capture_output=True).stdout)
    if status.get('BackendState') != 'Running':
        raise SystemExit('Tailscale must be connected before setup.')
    name = status['Self']['DNSName'].rstrip('.')
    if not name.endswith('.ts.net'):
        raise SystemExit('A Tailscale MagicDNS hostname is required.')
    serve = json.loads(run(binaries['tailscale'], 'serve', 'status', '--json', capture_output=True).stdout)
    routes = {8445: 13000, 8446: 13210, 8447: 18080, 8448: 13211}
    for port, target in routes.items():
        current = serve.get('Web', {}).get(f'{name}:{port}')
        expected = {'Handlers': {'/': {'Proxy': f'http://127.0.0.1:{target}'}}}
        if str(port) in serve.get('TCP', {}) and current != expected:
            raise SystemExit(f'Tailscale port {port} is already used by another service.')
        if serve.get('AllowFunnel', {}).get(f'{name}:{port}'):
            raise SystemExit(f'Port {port} has public Funnel enabled; disable it before private setup.')
    if not (ROOT / 'apps/desktop/.env.local').exists():
        raise SystemExit('apps/desktop/.env.local must contain MAIN_VITE_DEVICE_SECRET.')
    STATE.mkdir(parents=True, exist_ok=True)
    STATE.chmod(0o700)
    AGENTS.mkdir(parents=True, exist_ok=True)
    if not (STATE / 'tailscale-before.json').exists():
        (STATE / 'tailscale-before.json').write_text(json.dumps(serve, indent=2))
    if not (STATE / 'backend/data/db.sqlite3').exists() or not (STATE / 'bin/convex-local-backend').exists():
        raise SystemExit('Restore the backend data and install the pinned native binary before setup; refusing to create an empty database.')
    (STATE / 'backend/config.json').write_text(json.dumps({'hostname': name}))
    web_env = {**os.environ, 'ORCHESTRA_WEB_DIST_DIR': '.next-private', 'NEXT_PUBLIC_CONVEX_URL': f'https://{name}:8446',
               'NEXT_PUBLIC_TERMINAL_RELAY_URL': f'wss://{name}:8447'}
    run(binaries['bun'], 'run', '--cwd', 'apps/web', 'build', cwd=ROOT, env=web_env)
    install('com.orchestra.private-backend', [binaries['python3'], str(ROOT / 'infra/tailscale/backend.py')])
    install('com.orchestra.private-relay', [binaries['bun'], '--env-file=apps/desktop/.env.local',
            'apps/terminal-relay/src/main.ts'], {'CONVEX_URL': 'http://127.0.0.1:13210',
            'ALLOWED_ORIGINS': f'https://{name}:8445'})
    install('com.orchestra.private-web', [binaries['node'], str(ROOT / 'apps/web/node_modules/next/dist/bin/next'),
            'start', '--hostname', '127.0.0.1', '--port', '13000'],
            {'NODE_ENV': 'production', 'ORCHESTRA_WEB_DIST_DIR': '.next-private',
             **{k: v for k, v in web_env.items() if k.startswith('NEXT_PUBLIC_')}}, cwd=ROOT / 'apps/web')
    install('com.orchestra.private-backup', [binaries['python3'], str(ROOT / 'infra/tailscale/backup.py')],
            schedule={'Hour': 3, 'Minute': 30})
    for port, target in routes.items():
        run(binaries['tailscale'], 'serve', '--bg', f'--https={port}', f'http://127.0.0.1:{target}')
    print(f'Private phone URL: https://{name}:8445')
    print(f'Logs: {STATE}')
    print('Backend data stays in the private-network/backend/data directory.')


if __name__ == '__main__':
    main()
