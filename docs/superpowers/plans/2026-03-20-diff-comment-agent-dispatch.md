# Diff Comment & Agent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Esc-to-close for the diff view, and enable clicking diff lines to open a comment popover that dispatches Claude or Codex agents to fix the selected code.

**Architecture:** Extend the existing `DiffView` component with keyboard handling (Esc) and leverage `@pierre/diffs`'s built-in `onLineClick`, `lineAnnotations`, and `renderAnnotation` APIs to add inline comment popovers. A new `DiffCommentPopover` component handles the comment textarea and agent picker. On send, we reuse the existing `createSession` store action to spawn a new agent terminal with a prompt containing the user's comment, file path, and surrounding diff hunk.

**Tech Stack:** React 19, TypeScript, @pierre/diffs (PatchDiff), zustand (app-store), existing action-utils for agent command building.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/desktop/src/renderer/src/components/DiffView.tsx` | Modify | Add Esc handler, onLineClick, lineAnnotations, renderAnnotation, hunk extraction |
| `apps/desktop/src/renderer/src/components/DiffCommentPopover.tsx` | Create | Comment textarea + agent picker (Claude/Codex) + send button |
| `apps/desktop/src/renderer/src/utils/diff-hunk-parser.ts` | Create | Parse unified diff patch string to extract hunk around a given line number |
| `apps/desktop/src/renderer/src/utils/diff-hunk-parser.test.ts` | Create | Tests for hunk extraction logic |

---

### Task 1: Add Esc to close DiffView

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/DiffView.tsx`

- [ ] **Step 1: Add keydown listener for Escape**

In `DiffView.tsx`, add a `useEffect` that listens for `keydown` events. When `Escape` is pressed and no comment popover is open, call `onClose()`. When the popover IS open, close the popover instead.

```tsx
// Inside DiffView component, after existing useEffect hooks:
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (commentLine) {
        setCommentLine(null)
        setCommentText('')
      } else {
        onClose()
      }
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [commentLine, onClose])
```

Note: `commentLine` state will be added in Task 3. For this step, just add the Esc handler with the `onClose()` call (no popover state yet):

```tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [onClose])
```

- [ ] **Step 2: Test manually**

Open the app, navigate to a diff view, press Esc. It should close and return to the terminal view.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/DiffView.tsx
git commit -m "feat(diff): close diff view with Escape key"
```

---

### Task 2: Create diff hunk parser utility

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/diff-hunk-parser.ts`
- Create: `apps/desktop/src/renderer/src/utils/diff-hunk-parser.test.ts`

This utility parses a unified diff patch string and extracts the hunk surrounding a given line number, plus the content of the specific line.

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/renderer/src/utils/diff-hunk-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractHunkForLine, getLineContent } from './diff-hunk-parser'

const SAMPLE_PATCH = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,6 +10,8 @@ function hello() {
   const a = 1
   const b = 2
+  const c = 3
+  const d = 4
   const e = 5
   return a + b
 }
@@ -30,4 +32,3 @@ function goodbye() {
   console.log('bye')
-  console.log('removed')
   return true
 }`

describe('extractHunkForLine', () => {
  it('returns the hunk containing the given new-side line number', () => {
    const result = extractHunkForLine(SAMPLE_PATCH, 12, 'additions')
    expect(result).not.toBeNull()
    expect(result!.hunkText).toContain('const c = 3')
    expect(result!.hunkText).toContain('const d = 4')
  })

  it('returns the hunk for a deletion-side line', () => {
    const result = extractHunkForLine(SAMPLE_PATCH, 31, 'deletions')
    expect(result).not.toBeNull()
    expect(result!.hunkText).toContain("console.log('removed')")
  })

  it('returns null for a line not in any hunk', () => {
    const result = extractHunkForLine(SAMPLE_PATCH, 999, 'additions')
    expect(result).toBeNull()
  })
})

describe('getLineContent', () => {
  it('extracts the content of a specific new-side line', () => {
    const content = getLineContent(SAMPLE_PATCH, 12, 'additions')
    expect(content).toBe('  const c = 3')
  })

  it('extracts the content of a deletion-side line', () => {
    const content = getLineContent(SAMPLE_PATCH, 31, 'deletions')
    expect(content).toBe("  console.log('removed')")
  })

  it('returns null for non-existent line', () => {
    expect(getLineContent(SAMPLE_PATCH, 999, 'additions')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/desktop && bunx vitest run src/renderer/src/utils/diff-hunk-parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement diff-hunk-parser.ts**

Create `apps/desktop/src/renderer/src/utils/diff-hunk-parser.ts`:

```ts
import type { AnnotationSide } from '@pierre/diffs'

interface HunkResult {
  hunkHeader: string
  hunkText: string
}

/**
 * Parse a unified diff patch and extract the hunk containing a given line number.
 * `side` determines whether we're looking at old-file ("deletions") or new-file ("additions") line numbers.
 */
export function extractHunkForLine(
  patch: string,
  lineNumber: number,
  side: AnnotationSide
): HunkResult | null {
  const lines = patch.split('\n')
  let currentHunkHeader = ''
  let currentHunkLines: string[] = []
  let oldLine = 0
  let newLine = 0
  let found = false

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      if (found) break
      if (currentHunkLines.length > 0 && found) break
      currentHunkHeader = line
      currentHunkLines = [line]
      oldLine = parseInt(hunkMatch[1], 10)
      newLine = parseInt(hunkMatch[2], 10)
      continue
    }

    if (!currentHunkHeader) continue

    currentHunkLines.push(line)

    if (line.startsWith('-')) {
      if (side === 'deletions' && oldLine === lineNumber) found = true
      oldLine++
    } else if (line.startsWith('+')) {
      if (side === 'additions' && newLine === lineNumber) found = true
      newLine++
    } else if (line.startsWith(' ') || line === '') {
      if (side === 'deletions' && oldLine === lineNumber) found = true
      if (side === 'additions' && newLine === lineNumber) found = true
      oldLine++
      newLine++
    }
  }

  if (!found) return null

  return {
    hunkHeader: currentHunkHeader,
    hunkText: currentHunkLines.join('\n'),
  }
}

/**
 * Get the content of a specific line from a unified diff patch.
 */
export function getLineContent(
  patch: string,
  lineNumber: number,
  side: AnnotationSide
): string | null {
  const lines = patch.split('\n')
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10)
      newLine = parseInt(hunkMatch[2], 10)
      inHunk = true
      continue
    }

    if (!inHunk) continue

    if (line.startsWith('-')) {
      if (side === 'deletions' && oldLine === lineNumber) return line.slice(1)
      oldLine++
    } else if (line.startsWith('+')) {
      if (side === 'additions' && newLine === lineNumber) return line.slice(1)
      newLine++
    } else if (line.startsWith(' ') || line === '') {
      if (side === 'deletions' && oldLine === lineNumber) return line.slice(1)
      if (side === 'additions' && newLine === lineNumber) return line.slice(1)
      oldLine++
      newLine++
    }
  }

  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/desktop && bunx vitest run src/renderer/src/utils/diff-hunk-parser.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/diff-hunk-parser.ts apps/desktop/src/renderer/src/utils/diff-hunk-parser.test.ts
git commit -m "feat(diff): add unified diff hunk parser utility"
```

---

### Task 3: Create DiffCommentPopover component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/DiffCommentPopover.tsx`

The popover renders inline within a `renderAnnotation` callback. It contains a textarea, two agent buttons (Claude and Codex), and responds to Esc to dismiss.

- [ ] **Step 1: Create the component**

Create `apps/desktop/src/renderer/src/components/DiffCommentPopover.tsx`:

```tsx
import { useRef, useEffect } from 'react'

interface DiffCommentPopoverProps {
  lineNumber: number
  side: 'deletions' | 'additions'
  onSend: (agent: 'claude' | 'codex', comment: string) => void
  onClose: () => void
  commentText: string
  onCommentChange: (text: string) => void
}

export function DiffCommentPopover({
  lineNumber,
  side,
  onSend,
  onClose,
  commentText,
  onCommentChange,
}: DiffCommentPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const sideLabel = side === 'additions' ? '+' : '-'

  return (
    <div
      className="mx-2 my-1 rounded-lg border overflow-hidden"
      style={{
        backgroundColor: '#1a1a2e',
        borderColor: 'rgba(255,255,255,0.1)',
        maxWidth: 480,
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono"
        style={{ color: 'rgba(255,255,255,0.5)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span>Line {lineNumber} ({sideLabel})</span>
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={commentText}
        onChange={(e) => onCommentChange(e.target.value)}
        placeholder="Describe what to fix..."
        rows={3}
        className="w-full px-3 py-2 text-xs bg-transparent outline-none resize-none"
        style={{ color: 'rgba(255,255,255,0.85)' }}
      />

      {/* Actions */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={() => commentText.trim() && onSend('claude', commentText)}
          disabled={!commentText.trim()}
          className="px-3 py-1 rounded text-[11px] font-medium transition-opacity"
          style={{
            backgroundColor: '#d97706',
            color: '#fff',
            opacity: commentText.trim() ? 1 : 0.4,
          }}
        >
          Claude
        </button>
        <button
          onClick={() => commentText.trim() && onSend('codex', commentText)}
          disabled={!commentText.trim()}
          className="px-3 py-1 rounded text-[11px] font-medium transition-opacity"
          style={{
            backgroundColor: '#10a37f',
            color: '#fff',
            opacity: commentText.trim() ? 1 : 0.4,
          }}
        >
          Codex
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-[10px] px-2 py-1 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'rgba(255,255,255,0.4)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/DiffCommentPopover.tsx
git commit -m "feat(diff): add comment popover component with agent picker"
```

---

### Task 4: Wire everything together in DiffView

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/DiffView.tsx`

This is the main integration task. We add:
- Local state for `commentLine` and `commentText`
- `onLineClick` handler to set the comment line
- `lineAnnotations` array with the active comment annotation
- `renderAnnotation` that renders `DiffCommentPopover`
- `selectedLines` to highlight the clicked line
- Agent dispatch via `createSession` / `runAction`
- Update Esc handler to dismiss popover first

- [ ] **Step 1: Add imports and state**

Add to top of `DiffView.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import type { AnnotationSide, DiffLineAnnotation } from '@pierre/diffs/react'
import { DiffCommentPopover } from './DiffCommentPopover'
import { extractHunkForLine, getLineContent } from '../utils/diff-hunk-parser'
import { buildActionCommand, shellQuote } from '../../../shared/action-utils'
import type { CustomAction } from '../../../shared/types'
```

Add local state inside the component:

```tsx
const [commentLine, setCommentLine] = useState<{ lineNumber: number; side: AnnotationSide } | null>(null)
const [commentText, setCommentText] = useState('')

const createSession = useAppStore((s) => s.createSession)
```

- [ ] **Step 2: Update Esc handler**

Replace the simple Esc handler from Task 1 with the two-tier version:

```tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (commentLine) {
        setCommentLine(null)
        setCommentText('')
      } else {
        onClose()
      }
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [commentLine, onClose])
```

- [ ] **Step 3: Add onLineClick handler**

```tsx
const handleLineClick = useCallback((props: { lineNumber: number; annotationSide: AnnotationSide; event: PointerEvent }) => {
  const { lineNumber, annotationSide } = props
  // Toggle off if same line clicked again
  if (commentLine?.lineNumber === lineNumber && commentLine?.side === annotationSide) {
    setCommentLine(null)
    setCommentText('')
    return
  }
  setCommentLine({ lineNumber, side: annotationSide })
  setCommentText('')
}, [commentLine])
```

- [ ] **Step 4: Build lineAnnotations and renderAnnotation**

```tsx
const lineAnnotations: DiffLineAnnotation[] = commentLine
  ? [{ lineNumber: commentLine.lineNumber, side: commentLine.side }]
  : []

const handleRenderAnnotation = useCallback((annotation: DiffLineAnnotation) => {
  if (!commentLine) return null
  return (
    <DiffCommentPopover
      lineNumber={commentLine.lineNumber}
      side={commentLine.side}
      commentText={commentText}
      onCommentChange={setCommentText}
      onClose={() => {
        setCommentLine(null)
        setCommentText('')
      }}
      onSend={handleSendToAgent}
    />
  )
}, [commentLine, commentText, handleSendToAgent])
```

- [ ] **Step 5: Add agent dispatch handler**

```tsx
const handleSendToAgent = useCallback((agent: 'claude' | 'codex', comment: string) => {
  if (!activeWorkspaceId || !tree?.rootDir || !commentLine) return

  const hunkResult = extractHunkForLine(patch, commentLine.lineNumber, commentLine.side)
  const lineContent = getLineContent(patch, commentLine.lineNumber, commentLine.side)

  const promptParts = [`In file ${file}:`]
  if (hunkResult) {
    promptParts.push(`\nDiff hunk:\n\`\`\`\n${hunkResult.hunkText}\n\`\`\``)
  }
  if (lineContent) {
    promptParts.push(`\nSpecifically line ${commentLine.lineNumber}: ${lineContent}`)
  }
  promptParts.push(`\n${comment}`)
  const prompt = promptParts.join('\n')

  // Build shell command using buildActionCommand from action-utils
  const shellCmd = buildActionCommand({
    actionType: agent,
    command: prompt,
  } as CustomAction)

  if (!shellCmd) return

  const processStatus = agent === 'claude' ? 'claude' : 'codex'

  createSession(
    activeWorkspaceId,
    shellCmd,
    agent === 'claude' ? 'default-claude' : 'default-codex',
    agent === 'claude' ? '__claude__' : '__openai__',
    agent === 'claude' ? 'Claude' : 'Codex',
    processStatus as any,
  )

  // Close the diff view to show the new agent session
  setCommentLine(null)
  setCommentText('')
  onClose()
}, [activeWorkspaceId, tree?.rootDir, patch, commentLine, file, createSession, onClose])
```

- [ ] **Step 6: Update PatchDiff props**

Update the `<PatchDiff>` component to pass the new props:

```tsx
<PatchDiff
  patch={patch}
  options={{
    diffStyle: 'split',
    theme: 'github-dark',
    onLineClick: handleLineClick,
  }}
  lineAnnotations={lineAnnotations}
  selectedLines={commentLine ? { start: commentLine.lineNumber, end: commentLine.lineNumber, side: commentLine.side } : null}
  renderAnnotation={handleRenderAnnotation}
/>
```

- [ ] **Step 7: Test manually**

1. Open the app, go to a diff view
2. Press Esc — should close the diff
3. Click a diff line — popover should appear below it
4. Type a comment, press Esc — popover should close (diff stays)
5. Click a line, type a comment, click "Claude" — new Claude session should spawn with the prompt
6. Same for "Codex"

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/DiffView.tsx
git commit -m "feat(diff): wire line click, comment popover, and agent dispatch"
```

---

### Task 5: Add hover utility ("+" button)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/DiffView.tsx`

Add the `renderHoverUtility` prop to `PatchDiff` to show a "+" comment button when hovering over diff lines.

- [ ] **Step 1: Add renderHoverUtility**

```tsx
const handleRenderHoverUtility = useCallback(
  (getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined) => {
    const hovered = getHoveredLine()
    if (!hovered) return null
    return (
      <button
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setCommentLine({ lineNumber: hovered.lineNumber, side: hovered.side })
          setCommentText('')
        }}
        className="flex items-center justify-center rounded hover:bg-blue-500/30 transition-colors"
        style={{
          width: 18,
          height: 18,
          color: '#58a6ff',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        +
      </button>
    )
  },
  []
)
```

Update `PatchDiff`:

```tsx
<PatchDiff
  patch={patch}
  options={{
    diffStyle: 'split',
    theme: 'github-dark',
    onLineClick: handleLineClick,
    enableHoverUtility: true,
  }}
  lineAnnotations={lineAnnotations}
  selectedLines={commentLine ? { start: commentLine.lineNumber, end: commentLine.lineNumber, side: commentLine.side } : null}
  renderAnnotation={handleRenderAnnotation}
  renderHoverUtility={handleRenderHoverUtility}
/>
```

- [ ] **Step 2: Test manually**

Hover over diff lines. A small "+" button should appear. Clicking it should open the comment popover.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/DiffView.tsx
git commit -m "feat(diff): add hover utility button for line comments"
```
