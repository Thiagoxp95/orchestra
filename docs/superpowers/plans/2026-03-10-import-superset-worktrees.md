# Import Superset Worktrees — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Import from Superset" button in workspace settings that discovers and imports worktrees from the Superset app for the current repo.

**Architecture:** New IPC handler shells out to `sqlite3` (preinstalled on macOS) to query Superset's local SQLite database (`~/.superset/local.db`). The renderer shows a checklist of discovered worktrees and adds selected ones via the existing `addWorktree` store method.

**Tech Stack:** Electron IPC, sqlite3 CLI, React, zustand

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/types.ts` | Add `SupersetWorktree` type + update `ElectronAPI` |
| `src/main/index.ts` | Add `get-superset-worktrees` IPC handler |
| `src/preload/index.ts` | Expose `getSupersetWorktrees` in preload bridge |
| `src/renderer/src/components/SettingsDialog.tsx` | Add import UI to worktrees page |

---

## Chunk 1: Implementation

### Task 1: Add types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add SupersetWorktree type and update ElectronAPI**

In `src/shared/types.ts`, add after the `TerminalLaunchProfile` type (line ~112):

```typescript
export interface SupersetWorktree {
  path: string
  branch: string
}
```

And add to the `ElectronAPI` interface (after `removeWorktree`):

```typescript
getSupersetWorktrees: (repoPath: string) => Promise<SupersetWorktree[]>
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat: add SupersetWorktree type and ElectronAPI method"
```

---

### Task 2: Add IPC handler

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add `get-superset-worktrees` IPC handler**

Add after the `remove-worktree` handler (~line 546):

```typescript
ipcMain.handle('get-superset-worktrees', (_, repoPath: string) => {
  const dbPath = join(homedir(), '.superset', 'local.db')

  return new Promise<{ path: string; branch: string }[]>((resolve) => {
    // Check if Superset DB exists
    if (!fs.existsSync(dbPath)) {
      resolve([])
      return
    }

    // Query: find project by main_repo_path, then get its worktrees
    const query = `
      SELECT w.path, w.branch
      FROM worktrees w
      JOIN projects p ON w.project_id = p.id
      WHERE p.main_repo_path = '${repoPath.replace(/'/g, "''")}'
    `

    execFile('sqlite3', ['-json', dbPath, query], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([])
        return
      }
      try {
        const rows = JSON.parse(stdout) as { path: string; branch: string }[]
        // Filter to only worktrees whose directories still exist
        resolve(rows.filter(r => fs.existsSync(r.path)))
      } catch {
        resolve([])
      }
    })
  })
})
```

Key details:
- Uses `sqlite3 -json` for easy parsing (available on macOS)
- SQL-escapes single quotes in repoPath to prevent injection
- Filters out worktrees whose directories no longer exist on disk
- Returns empty array on any error (Superset not installed, DB missing, etc.)

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat: add get-superset-worktrees IPC handler"
```

---

### Task 3: Expose in preload bridge

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Add getSupersetWorktrees to preload**

Add after the `removeWorktree` entry (~line 159):

```typescript
getSupersetWorktrees: (repoPath: string) => {
  return ipcRenderer.invoke('get-superset-worktrees', repoPath)
},
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat: expose getSupersetWorktrees in preload bridge"
```

---

### Task 4: Add import UI to SettingsDialog

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add new props to SettingsDialog**

Add to `SettingsDialogProps`:

```typescript
workspaceRootDir: string | null
existingTreePaths: string[]
onImportWorktrees: (paths: string[]) => void
```

Add to the destructured props in the component.

- [ ] **Step 2: Add import state and handler**

Add state variables inside the component:

```typescript
const [supersetWorktrees, setSupersetWorktrees] = useState<{ path: string; branch: string }[]>([])
const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set())
const [importLoading, setImportLoading] = useState(false)
const [importDone, setImportDone] = useState(false)
```

Add handler:

```typescript
const handleDiscoverSuperset = async () => {
  if (!workspaceRootDir) return
  setImportLoading(true)
  try {
    const worktrees = await window.electronAPI.getSupersetWorktrees(workspaceRootDir)
    const filtered = worktrees.filter(w => !existingTreePaths.includes(w.path))
    setSupersetWorktrees(filtered)
    setSelectedImports(new Set(filtered.map(w => w.path)))
  } finally {
    setImportLoading(false)
  }
}

const handleImportSelected = () => {
  const paths = Array.from(selectedImports)
  if (paths.length > 0) {
    onImportWorktrees(paths)
    setImportDone(true)
  }
}

const toggleImportSelection = (path: string) => {
  setSelectedImports(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
}
```

- [ ] **Step 3: Add UI to worktrees page**

Add below the existing "Default directory" section in the worktrees page (after the closing `</p>` at ~line 324), inside the same `<div>`:

```tsx
{/* Import from Superset */}
<div className="mt-6 pt-4" style={{ borderTop: `1px solid ${borderClr}` }}>
  <label className="block text-sm mb-2" style={{ color: mutedTxt }}>Import from Superset</label>

  {!importDone && supersetWorktrees.length === 0 && (
    <button
      onClick={handleDiscoverSuperset}
      disabled={importLoading || !workspaceRootDir}
      className="px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
      style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
    >
      {importLoading ? 'Searching...' : 'Find Superset worktrees'}
    </button>
  )}

  {!importDone && supersetWorktrees.length > 0 && (
    <div className="space-y-2">
      {supersetWorktrees.map((wt) => (
        <label
          key={wt.path}
          className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
          style={{ backgroundColor: inputBg }}
        >
          <input
            type="checkbox"
            checked={selectedImports.has(wt.path)}
            onChange={() => toggleImportSelection(wt.path)}
            className="accent-current"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate" style={{ color: txt }}>{wt.branch}</div>
            <div className="text-xs truncate font-mono" style={{ color: mutedTxt }}>{wt.path}</div>
          </div>
        </label>
      ))}
      <button
        onClick={handleImportSelected}
        disabled={selectedImports.size === 0}
        className="mt-2 px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
        style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
      >
        Import {selectedImports.size} worktree{selectedImports.size !== 1 ? 's' : ''}
      </button>
    </div>
  )}

  {!importDone && supersetWorktrees.length === 0 && !importLoading && (
    <p className="mt-2 text-xs" style={{ color: mutedTxt }}>
      Discover worktrees created in Superset for this repository.
    </p>
  )}

  {importDone && (
    <p className="text-sm" style={{ color: txt }}>
      Worktrees imported. Save to apply.
    </p>
  )}
</div>
```

- [ ] **Step 4: Pass new props from Sidebar**

In `Sidebar.tsx`, update the `<SettingsDialog>` usage (~line 818) to pass:

```tsx
workspaceRootDir={workspace.trees[0]?.rootDir ?? null}
existingTreePaths={workspace.trees.map(t => t.rootDir)}
onImportWorktrees={(paths) => {
  if (!activeWorkspaceId) return
  for (const p of paths) {
    addWorktree(activeWorkspaceId, p)
  }
}}
```

Note: `addWorktree` is already available in the Sidebar component from the store.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/SettingsDialog.tsx apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat: add Import from Superset UI in workspace worktrees settings"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Build and test**

Run: `cd apps/desktop && bun run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 2: Manual test**

1. Open Orchestra
2. Open a workspace that has a corresponding Superset project (e.g., brotinho)
3. Go to Settings > Worktrees
4. Click "Find Superset worktrees"
5. Verify worktrees appear with checkboxes
6. Select some, click Import
7. Verify they appear in the sidebar as new trees
8. Verify worktrees already in Orchestra are NOT shown in the import list
