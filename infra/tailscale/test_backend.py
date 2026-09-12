import json
from pathlib import Path
import tempfile
import unittest

from backend import backend_arguments


class BackendTests(unittest.TestCase):
    def test_refuses_empty_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'refusing an empty'):
                backend_arguments(Path(directory))

    def test_restored_identity_and_loopback_only(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'bin').mkdir()
            (state / 'bin/convex-local-backend').touch()
            data = state / 'backend/data'
            (data / 'credentials').mkdir(parents=True)
            (data / 'db.sqlite3').touch()
            (data / 'credentials/instance_name').write_text('existing-instance')
            (data / 'credentials/instance_secret').write_text('existing-secret')
            config = state / 'backend/config.json'
            config.write_text(json.dumps({'hostname': 'mac.example.ts.net'}))
            args = backend_arguments(state)
            self.assertEqual(args[args.index('--interface') + 1], '127.0.0.1')
            self.assertEqual(args[args.index('--instance-name') + 1], 'existing-instance')
            self.assertEqual(args[-1], str(data / 'db.sqlite3'))
            config.write_text(json.dumps({'hostname': 'evil.test/path.ts.net'}))
            with self.assertRaises(ValueError):
                backend_arguments(state)


if __name__ == '__main__':
    unittest.main()
