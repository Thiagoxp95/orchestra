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
