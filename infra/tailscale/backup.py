#!/usr/bin/env python3
"""Daily portable backup plus the settings needed to restore it."""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = Path.home() / 'Library/Application Support/Orchestra/private-network'


def main():
    os.umask(0o077)
    backups = STATE / 'backups'
    backups.mkdir(parents=True, exist_ok=True)
    with (backups / '.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        env = {**os.environ, 'CONVEX_SELF_HOSTED_URL': 'http://127.0.0.1:13210'}
        pending = backups / 'environment.pending'
        with pending.open('w') as output:
            subprocess.run(['bun', 'x', 'convex', 'env', 'list'], cwd=ROOT / 'apps/backend',
                           env=env, stdout=output, check=True)
        pending.replace(backups / 'environment.env')
        shutil.copytree(STATE / 'backend/data/credentials', backups / 'credentials', dirs_exist_ok=True)
        for attempt in range(21):
            result = subprocess.run(['bash', str(ROOT / 'infra/convex/backup.sh'), str(backups)],
                                    cwd=ROOT, env=env, capture_output=True, text=True)
            if result.returncode == 0:
                print(result.stdout, end='')
                return
            if 'ExportInProgress' not in result.stderr or attempt == 20:
                print(result.stderr, end='')
                result.check_returncode()
            print('Waiting for an existing export to finish before backing up.', flush=True)
            time.sleep(30)


if __name__ == '__main__':
    main()
