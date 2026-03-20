# Auto-Update Feature Design

## Overview

Add in-app auto-update to Orchestra using `electron-updater`. The app checks for new GitHub Releases on launch and every 30 minutes. When a new version is found, a sidebar section appears above Ports allowing the user to download and install the update with a single click, then restart to apply.

## Architecture

### Main Process — `src/main/updater.ts`

New module wrapping `electron-updater`'s `autoUpdater`:

- **Production only**: guarded by `app.isPackaged` — skips initialization entirely in dev mode to avoid errors
- **On app ready**: call `checkForUpdates()`, then set a 30-minute interval
- **Auto-download disabled**: `autoUpdater.autoDownload = false` — download only starts when user clicks "Update"
- **Auto-install on quit disabled**: `autoUpdater.autoInstallOnQuit = false` — user controls when to restart
- Forwards lifecycle events to renderer via IPC channel `update-status`
- **Normalizes `releaseNotes`**: `electron-updater` may return `string | ReleaseNoteInfo[] | null` — the module normalizes this to a plain string before forwarding to renderer (joins array entries if needed)

**Events emitted to renderer:**

| Event | Payload | Notes |
|---|---|---|
| `checking` | `{}` | |
| `available` | `{ version, releaseNotes }` | `releaseNotes` normalized to string |
| `not-available` | `{}` | |
| `downloading` | `{ percent }` | |
| `downloaded` | `{ version }` | |
| `error` | `{ message }` | |

**IPC handlers registered:**

| Channel | Direction | Purpose |
|---|---|---|
| `update-status` | main → renderer | Status change notifications |
| `check-for-update` | renderer → main | Manual check trigger |
| `download-update` | renderer → main | Start downloading |
| `install-update` | renderer → main | Quit and install |

### Preload — `src/preload/index.ts`

Add to `electronAPI`, following the existing listener pattern (returns a dispose function):

```ts
onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
  const handler = (_e: IpcRendererEvent, status: UpdateStatus) => callback(status)
  ipcRenderer.on('update-status', handler)
  return () => { ipcRenderer.removeListener('update-status', handler) }
},
checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
downloadUpdate: () => ipcRenderer.invoke('download-update'),
installUpdate: () => ipcRenderer.invoke('install-update'),
```

Also add `'update-status'` to the existing global `removeAllListeners()` cleanup.

### Shared Types — `src/shared/types.ts`

```ts
type UpdateStatusType = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

interface UpdateStatus {
  status: UpdateStatusType
  version?: string       // populated for: available, downloaded
  releaseNotes?: string  // populated for: available
  percent?: number       // populated for: downloading (0-100)
  message?: string       // populated for: error
}
```

### Renderer — Sidebar section in `Sidebar.tsx`

Inserted **above the Ports section**, only visible when status is `available`, `downloading`, or `downloaded`. Hidden when sidebar is collapsed (same `!collapsed` guard as Ports).

**Three visual states:**

1. **Available** — Label "Update v{version}" + clickable "Update" button. Clicking triggers `downloadUpdate()`.
2. **Downloading** — Label "Updating..." + progress bar showing `percent%`. Progress bar uses workspace accent color.
3. **Downloaded** — Label "Ready" + "Restart" button. Clicking triggers `installUpdate()`.

**Error handling for user-initiated downloads:** If download fails after user clicks "Update", briefly show "Update failed" for 5 seconds, then revert to `available` state so user can retry. Background check errors remain silent.

**Styling:**
- Same pattern as other sidebar sections: `px-3 py-2 border-t`, `text-[10px]` labels
- Colors follow `txtColor`/`wsColor` theming
- Progress bar: thin bar (2-3px height) with workspace color fill

**State management:**
- `useState<UpdateStatus | null>` initialized to `null`
- `useEffect` subscribes to `onUpdateStatus` on mount, returns the dispose function in cleanup

### electron-builder.yml

Add publish configuration:

```yaml
publish:
  provider: github
  owner: Thiagoxp95
  repo: orchestra
```

This tells `electron-updater` where to check for releases and tells `electron-builder` where to upload assets (the existing `/ship` flow already creates GitHub Releases with the right tag format).

**Important:** `electron-updater` uses the **ZIP** artifact (not DMG) for applying macOS updates. The existing config already produces both `dmg` and `zip` targets — the ZIP target must not be removed.

### package.json

Add dependency:

```
"electron-updater": "^6.x"
```

## Data Flow

```
/ship creates GitHub Release with DMG/ZIP assets
         |
         v
autoUpdater.checkForUpdates() — on launch + every 30min (production only)
         |
         v
GitHub Releases API -> "new version found" (version > current)
         |
         v
IPC 'update-status' { status: 'available', version } -> renderer
         |
         v
Sidebar section appears: "Update v0.5.0" [Update]
         |
         v
User clicks -> downloadUpdate() -> autoUpdater.downloadUpdate()
         |
         v
Progress events -> IPC -> progress bar fills
         |
         v
Download complete -> { status: 'downloaded' }
         |
         v
Sidebar shows: "Ready" [Restart]
         |
         v
User clicks -> autoUpdater.quitAndInstall()
```

## Edge Cases

- **Development mode**: Updater not initialized when `!app.isPackaged`. No errors, no checks.
- **Error during background check**: Silent — section stays hidden. Log to console. Next 30-min check will retry.
- **Error during user-initiated download**: Show "Update failed" for 5 seconds, revert to `available` state for retry.
- **Offline**: `checkForUpdates()` fails silently, section stays hidden.
- **Already up to date**: `not-available` status — section stays hidden.
- **User ignores update**: Section persists across the session. Re-detected on startup check next launch.
- **macOS code signing**: Updates must be signed with the same certificate. Already handled by existing notarization config.
- **Collapsed sidebar**: Update section hidden when collapsed (same as Ports).

## What Changes

| File | Change |
|---|---|
| `src/main/updater.ts` | New file — updater module |
| `src/main/index.ts` | Import and initialize updater |
| `src/preload/index.ts` | Add 4 new IPC methods + update global cleanup |
| `src/shared/types.ts` | Add `UpdateStatus` type |
| `src/renderer/src/components/Sidebar.tsx` | Add update section above Ports |
| `electron-builder.yml` | Add `publish` config |
| `package.json` | Add `electron-updater` dependency |
