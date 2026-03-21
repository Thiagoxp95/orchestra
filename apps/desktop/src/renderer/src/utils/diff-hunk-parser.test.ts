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
