/**
 * The branch mark, shared by every place a worktree is named: the sidebar's tree
 * rows, the roll cards, and the header's worktree chip. One path so all three read
 * as the same thing at three different sizes.
 */
export function BranchGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="3.5" r="1.6" />
      <path d="M4 5.1v5.8M12 5.1v1.4c0 2-1.6 3.5-3.5 3.5H4" />
    </svg>
  )
}
