# Turborepo Monorepo Conversion Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the Orchestra Electron app into a Turborepo monorepo with apps for desktop, marketing website (Next.js), and Convex backend.

**Architecture:** Move the existing Electron app into `apps/desktop/`, scaffold `apps/web/` (Next.js) and `apps/backend/` (Convex), with a root `turbo.json` orchestrating builds. Package scope is `@orchestra`. Package manager is bun with workspaces.

**Tech Stack:** Turborepo, bun workspaces, electron-vite, Next.js, Convex

---

### Task 1: Create root monorepo scaffolding

**Files:**
- Create: `package.json` (new root — replaces current)
- Create: `turbo.json`
- Create: `.gitignore` (update for monorepo)

**Step 1: Create root `package.json`**

```json
{
  "name": "orchestra",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2"
  }
}
```

**Step 2: Create `turbo.json`**

```json
{
  "$schema": "https://turborepo.dev/schema.v2.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "out/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {}
  }
}
```

**Step 3: Commit scaffolding (do NOT install yet)**

```bash
git add package.json turbo.json
git commit -m "chore: add turborepo root scaffolding"
```

---

### Task 2: Move Electron app into `apps/desktop/`

**Files:**
- Move: `src/` → `apps/desktop/src/`
- Move: `electron.vite.config.ts` → `apps/desktop/`
- Move: `electron-builder.yml` → `apps/desktop/`
- Move: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json` → `apps/desktop/`
- Move: `terminal-host.js` → `apps/desktop/`
- Move: `resources/` → `apps/desktop/resources/` (if it exists)
- Create: `apps/desktop/package.json`

**Step 1: Create `apps/desktop/` directory and move files**

```bash
mkdir -p apps/desktop
git mv src apps/desktop/src
git mv electron.vite.config.ts apps/desktop/
git mv electron-builder.yml apps/desktop/
git mv tsconfig.json apps/desktop/
git mv tsconfig.node.json apps/desktop/
git mv tsconfig.web.json apps/desktop/
git mv terminal-host.js apps/desktop/
# Only if resources/ exists and has files:
git mv resources apps/desktop/resources 2>/dev/null || true
```

**Step 2: Create `apps/desktop/package.json`**

Take the old root `package.json` dependencies/devDependencies and scripts. The new file:

```json
{
  "name": "@orchestra/desktop",
  "version": "1.0.0",
  "description": "Orchestra desktop app",
  "main": "./out/main/index.js",
  "scripts": {
    "start": "electron-vite preview",
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "postinstall": "electron-builder install-app-deps",
    "build:unpack": "electron-vite build && electron-builder --dir",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:win": "electron-vite build && electron-builder --win",
    "build:linux": "electron-vite build && electron-builder --linux"
  },
  "dependencies": {
    "@electron-toolkit/preload": "^3.0.0",
    "@electron-toolkit/utils": "^3.0.0",
    "@pierre/diffs": "^1.0.11",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-serialize": "^0.14.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/headless": "^6.0.0",
    "electron-store": "^11.0.2",
    "hugeicons-react": "^0.4.0",
    "node-pty": "^1.1.0",
    "react-colorful": "^5.6.1",
    "tree-kill": "^1.2.2",
    "xterm": "^5.3.0",
    "zustand": "^5.0.11"
  },
  "devDependencies": {
    "@electron-toolkit/tsconfig": "^1.0.1",
    "@tailwindcss/vite": "^4.2.1",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "electron-vite": "^2.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "tailwindcss": "^4.2.1",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

**Step 3: Update `electron.vite.config.ts` paths**

The paths in `electron.vite.config.ts` use `resolve('src/...')` which is relative — these should still work since the config file is now in `apps/desktop/` alongside `src/`. The `@renderer` alias also uses relative resolve. **No changes needed.**

**Step 4: Update `electron-builder.yml`**

The `files` exclusions and `asarUnpack` paths are relative to the package dir. **No changes needed.**

**Step 5: Delete old root files that were moved**

The old root `package.json` was already replaced in Task 1. Delete stale files:

```bash
rm -f tsconfig.node.tsbuildinfo
rm -f package-lock.json
rm -f bun.lock
```

**Step 6: Commit the move**

```bash
git add -A
git commit -m "refactor: move electron app into apps/desktop"
```

---

### Task 3: Clean up root and install

**Step 1: Ensure root `.gitignore` covers monorepo patterns**

Add to `.gitignore` if not present:

```
node_modules
.turbo
out
dist
.next
```

**Step 2: Install dependencies from root**

```bash
bun install
```

**Step 3: Verify the desktop app builds**

```bash
cd apps/desktop && bun run build
```

Fix any path issues if the build fails (most likely cause: tsconfig paths).

**Step 4: Verify the desktop app runs in dev**

```bash
cd apps/desktop && bun run dev
```

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: verify desktop app builds in monorepo"
```

---

### Task 4: Scaffold Next.js marketing website

**Step 1: Create the Next.js app**

```bash
cd apps && bunx create-next-app@latest web --typescript --tailwind --eslint --app --src-dir --no-import-alias --use-bun
```

**Step 2: Update `apps/web/package.json` name**

Change the `name` field to `@orchestra/web`.

**Step 3: Verify it builds**

```bash
cd apps/web && bun run build
```

**Step 4: Verify turbo runs both apps**

```bash
# From root
turbo run build
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold next.js marketing website"
```

---

### Task 5: Scaffold Convex backend

**Step 1: Create the Convex app directory**

```bash
mkdir -p apps/backend
```

**Step 2: Create `apps/backend/package.json`**

```json
{
  "name": "@orchestra/backend",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "convex dev",
    "build": "convex deploy --cmd 'echo skip'"
  },
  "dependencies": {
    "convex": "^1"
  }
}
```

**Step 3: Initialize Convex**

```bash
cd apps/backend && bunx convex init
```

This creates the `convex/` directory with `_generated/` and a sample schema.

**Step 4: Install from root**

```bash
cd /path/to/root && bun install
```

**Step 5: Verify turbo sees all three apps**

```bash
turbo run build --dry
```

Should list `@orchestra/desktop`, `@orchestra/web`, `@orchestra/backend`.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold convex backend"
```

---

### Task 6: Final verification

**Step 1: Run full turbo build from root**

```bash
turbo run build
```

All three apps should build successfully.

**Step 2: Run turbo dev and verify desktop + web start**

```bash
turbo run dev --filter=@orchestra/desktop
turbo run dev --filter=@orchestra/web
```

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: finalize turborepo monorepo setup"
```
