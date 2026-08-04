/**
 * The pull-request mark for a worktree, in GitHub's own three shapes so the state
 * reads from the glyph alone (merged / closed / open-or-draft) — the same marks
 * the desktop sidebar draws next to a branch. Currentcolor throughout, so it
 * follows whatever the row is tinted.
 */
export function PRGlyph({ state, size = 12 }: { state?: string; size?: number }) {
  if (state === 'MERGED') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
        <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
      </svg>
    )
  }
  if (state === 'CLOSED') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
        <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.28a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L10.56 3.5l1.22 1.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L9.5 4.56 8.28 5.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L8.44 3.5 7.22 2.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L9.5 2.44ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
      </svg>
    )
  }
  // OPEN or DRAFT
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  )
}
