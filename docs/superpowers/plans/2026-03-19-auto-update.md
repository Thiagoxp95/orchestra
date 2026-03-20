# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app auto-update to Orchestra so users see a sidebar notification when a new version is available and can download + install it with one click.

**Architecture:** New `updater.ts` module in main process wraps `electron-updater`, checks GitHub Releases on launch + every 30 min (production only). Status forwarded to renderer via IPC. Sidebar section appears above Ports when an update is available/downloading/ready.

**Tech Stack:** electron-updater, Electron IPC, React (useState/useEffect), existing sidebar component patterns

**Spec:** `docs/superpowers/specs/2026-03-19-auto-update-design.md`

---

### Task 1: Install electron-updater and configure publishing

**Files:**
- Modify: `apps/desktop/package.json` — add `electron-updater` dependency
- Modify: `apps/desktop/electron-builder.yml` — add `publish` config

- [ ] **Step 1: Add electron-updater dependency**

```bash
cd apps/desktop && bun add electron-updater
```

- [ ] **Step 2: Add publish config to electron-builder.yml**

Append to the end of `apps/desktop/electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: Thiagoxp95
  repo: orchestra
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json apps/desktop/electron-builder.yml bun.lock
git commit -m "feat(update): add electron-updater dependency and github publish config"
```

---

### Task 2: Add UpdateStatus type to shared types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts` — add `UpdateStatus` type and extend `ElectronAPI`

- [ ] **Step 1: Add UpdateStatus type**

Add at the end of `apps/desktop/src/shared/types.ts`, before the closing of the file:

```ts
// Auto-update
export type UpdateStatusType = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateStatus {
  status: UpdateStatusType
  version?: string       // populated for: available, downloaded
  releaseNotes?: string  // populated for: available
  percent?: number       // populated for: downloading (0-100)
  message?: string       // populated for: error
}
```

- [ ] **Step 2: Extend ElectronAPI interface**

Add these methods to the `ElectronAPI` interface in `apps/desktop/src/shared/types.ts`, after the Skills section:

```ts
  // Auto-update
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  checkForUpdate: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat(update): add UpdateStatus type and ElectronAPI methods"
```

---

### Task 3: Create updater module in main process

**Files:**
- Create: `apps/desktop/src/main/updater.ts`

- [ ] **Step 1: Create the updater module**

Create `apps/desktop/src/main/updater.ts`:

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

let mainWin: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null

function send(status: UpdateStatus): void {
  mainWin?.webContents.send('update-status', status)
}

function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n: any) => n.note ?? '').filter(Boolean).join('\n')
  }
  return undefined
}

export function initUpdater(win: BrowserWindow | null): void {
  if (!app.isPackaged || !win) return

  mainWin = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnQuit = false

  autoUpdater.on('checking-for-update', () => {
    send({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    send({
      status: 'available',
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    })
  })

  autoUpdater.on('update-not-available', () => {
    send({ status: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    send({ status: 'error', message: err?.message ?? 'Update error' })
  })

  // IPC handlers
  ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates())
  ipcMain.handle('download-update', () => autoUpdater.downloadUpdate())
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  // Initial check + 30-min interval
  autoUpdater.checkForUpdates().catch(() => {})
  checkInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 30 * 60 * 1000)
}

export function stopUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/updater.ts
git commit -m "feat(update): create updater module wrapping electron-updater"
```

---

### Task 4: Wire updater into main process lifecycle

**Files:**
- Modify: `apps/desktop/src/main/index.ts` — import and call `initUpdater`

- [ ] **Step 1: Add import**

Add to imports at top of `apps/desktop/src/main/index.ts`:

```ts
import { initUpdater, stopUpdater } from './updater'
```

- [ ] **Step 2: Call initUpdater after window creation**

In the `createWindow()` function, after the window is fully set up (after the `loadURL`/`loadFile` block, around where `initClaudeWatcher` and other init calls happen), add:

```ts
initUpdater(mainWindow)
```

Find the right location by looking for where other init functions are called after the window loads (e.g. `initClaudeWatcher(mainWindow)`). Follow the same pattern — pass `mainWindow` without `!` assertion.

- [ ] **Step 3: Add stopUpdater to cleanup**

Find the `window-all-closed` handler (line ~864) or the existing cleanup code. Add `stopUpdater()` before `app.quit()`:

```ts
app.on('window-all-closed', () => {
  stopUpdater()
  app.quit()
})
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(update): wire updater into app lifecycle"
```

---

### Task 5: Add IPC methods to preload

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` — add 3 new API methods + update cleanup

- [ ] **Step 1: Add import for UpdateStatus**

Add `UpdateStatus` to the import from `'../shared/types'` at the top of `apps/desktop/src/preload/index.ts`:

```ts
import type {
  // ... existing imports ...
  UpdateStatus,
} from '../shared/types'
```

- [ ] **Step 2: Add update methods to the api object**

Add before the closing `}` of the `api` object (after the Skills section), following the existing listener pattern:

```ts
  // Auto-update
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const handler = (_event: any, status: UpdateStatus) => callback(status)
    ipcRenderer.on('update-status', handler)
    return () => { ipcRenderer.removeListener('update-status', handler) }
  },
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
```

- [ ] **Step 3: Add update-status to removeAllListeners**

In the `removeAllListeners` method, add:

```ts
ipcRenderer.removeAllListeners('update-status')
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(update): add update IPC methods to preload"
```

---

### Task 6: Add update section to Sidebar

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx` — add update UI above Ports

- [ ] **Step 1: Add import and state for update status**

Add import at the top of `Sidebar.tsx`:

```ts
import type { UpdateStatus } from '../../../../shared/types'
```

Add state near other state declarations in the Sidebar component:

```ts
const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
const updateStatusRef = useRef<UpdateStatus | null>(null)
```

Add useEffect to subscribe to update status (near the other useEffects):

```ts
useEffect(() => {
  const dispose = window.electronAPI.onUpdateStatus((status) => {
    if (status.status === 'error' && updateStatusRef.current?.status === 'downloading') {
      // Download failed — briefly revert to available so user can retry
      setUpdateStatus((prev) => prev ? { ...prev, status: 'available' } : null)
      return
    }
    updateStatusRef.current = status
    setUpdateStatus(status)
  })
  return dispose
}, [])
```

- [ ] **Step 2: Add the update section JSX above the Ports section**

Find the `{/* Ports */}` comment (line ~1233 in Sidebar.tsx). Insert this block BEFORE it:

```tsx
{/* Auto-update */}
{!collapsed && updateStatus && ['available', 'downloading', 'downloaded'].includes(updateStatus.status) && (
  <div className="px-3 py-2 shrink-0 border-t" style={{ borderColor }}>
    {updateStatus.status === 'available' && (
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: txtColor }}>
          Update v{updateStatus.version}
        </span>
        <button
          onClick={() => window.electronAPI.downloadUpdate()}
          className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors"
          style={{
            backgroundColor: txtColor,
            color: wsColor,
          }}
        >
          Update
        </button>
      </div>
    )}
    {updateStatus.status === 'downloading' && (
      <div>
        <span className="text-[10px]" style={{ color: txtColor }}>
          Updating... {updateStatus.percent ?? 0}%
        </span>
        <div
          className="mt-1 h-[3px] rounded-full overflow-hidden"
          style={{ backgroundColor: `${txtColor}20` }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${updateStatus.percent ?? 0}%`,
              backgroundColor: txtColor,
            }}
          />
        </div>
      </div>
    )}
    {updateStatus.status === 'downloaded' && (
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: txtColor }}>
          Ready to update
        </span>
        <button
          onClick={() => window.electronAPI.installUpdate()}
          className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors"
          style={{
            backgroundColor: txtColor,
            color: wsColor,
          }}
        >
          Restart
        </button>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: Verify build**

```bash
cd apps/desktop && bun run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(update): add auto-update section to sidebar"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full build**

```bash
cd apps/desktop && bun run build
```

Expected: Clean build, no errors.

- [ ] **Step 2: Run dev mode**

```bash
cd apps/desktop && bun run dev
```

Expected: App launches. No updater errors in console (updater skips in dev mode due to `app.isPackaged` guard). Sidebar does not show update section in dev (expected — no update status emitted).

- [ ] **Step 3: Verify typecheck**

```bash
cd apps/desktop && bun run typecheck
```

Expected: No type errors from the new code.
