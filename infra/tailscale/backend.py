#!/usr/bin/env python3
"""Run the restored Convex backend on loopback, supervised by launchd."""
import json
import os
from pathlib import Path

STATE = Path.home() / 'Library/Application Support/Orchestra/private-network'


def backend_arguments(state):
    data = state / 'backend/data'
    binary = state / 'bin/convex-local-backend'
    if not binary.is_file() or not (data / 'db.sqlite3').is_file():
        raise ValueError('Missing backend binary or restored database; refusing an empty deployment')
    hostname = json.loads((state / 'backend/config.json').read_text())['hostname']
    if not hostname.endswith('.ts.net') or any(c in hostname for c in '/:@ '):
        raise ValueError('Expected a Tailscale hostname')
    credentials = data / 'credentials'
    name = (credentials / 'instance_name').read_text().strip()
    secret = (credentials / 'instance_secret').read_text().strip()
    if not name or not secret:
        raise ValueError('Missing restored instance credentials')
    return [str(binary), '--interface', '127.0.0.1', '--port', '13210',
            '--site-proxy-port', '13211', '--convex-origin', f'https://{hostname}:8446',
            '--convex-site', f'https://{hostname}:8448', '--instance-name', name,
            '--instance-secret', secret, '--local-storage', str(data / 'storage'),
            '--disable-beacon', str(data / 'db.sqlite3')]


if __name__ == '__main__':
    arguments = backend_arguments(STATE)
    os.environ.setdefault('DOCUMENT_RETENTION_DELAY', '3600')
    os.environ.setdefault('RUST_LOG', 'info')
    os.environ['DISABLE_METRICS_ENDPOINT'] = '1'
    os.execv(arguments[0], arguments)
