---
description: Start the Orchestra desktop app in dev mode (electron-vite)
allowed-tools: Bash
---

Run the desktop app in development mode.

Use Bash with `run_in_background: true` to start electron-vite so it keeps running:

```
cd /Users/txp/Pessoal/orchestra/apps/desktop && bun run dev
```

After starting, report the background shell ID so the user can monitor logs. Do not poll or sleep — the dev server runs until stopped.
