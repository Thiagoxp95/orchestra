/**
 * Mirror of the desktop's workspace-emoji fallback (apps/desktop/src/shared/workspace-emoji.ts).
 *
 * The desktop resolves this before pushing state, so `emoji` normally arrives already
 * filled in. Older desktop builds send the raw (often absent) workspace emoji, which
 * left every workspace without one of its own showing a bare name here while the
 * desktop drew an icon — so resolve it again on this side rather than trusting the
 * mirror to have done it.
 */
const WORKSPACE_DEFAULT_EMOJIS = ['📁', '📂', '🗂️', '📦', '🔧', '⚡', '🚀', '💼', '🎯']

/** The emoji shown for a workspace at `index` in the sidebar's order. */
export function workspaceDisplayEmoji(emoji: string | undefined, index: number): string {
  if (emoji) return emoji
  // A caller that couldn't place the workspace (findIndex → -1) still gets an icon.
  const i = index >= 0 ? index : 0
  return WORKSPACE_DEFAULT_EMOJIS[i % WORKSPACE_DEFAULT_EMOJIS.length]
}
