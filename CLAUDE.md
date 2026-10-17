Verify with `bun run check` (lint, typecheck, tests). Wrap it in `rtk proxy` to read the test summary. The voice sidecar's tests run with `bun run test:sidecar`.

After `bun run release`, wait on it with `bun run release:wait` from apps/desktop.
