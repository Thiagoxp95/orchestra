/**
 * A workspace's emoji is optional, so the sidebar falls back to a stand-in picked
 * by the workspace's position in the list. That fallback is part of the workspace's
 * identity as far as the user is concerned — the phone has to resolve it exactly the
 * same way the desktop does, or half the rows arrive with no icon at all.
 */
export const WORKSPACE_DEFAULT_EMOJIS = ['📁', '📂', '🗂️', '📦', '🔧', '⚡', '🚀', '💼', '🎯']

/** The emoji actually shown for a workspace at `index` in the sidebar's order. */
export function workspaceDisplayEmoji(emoji: string | undefined, index: number): string {
  if (emoji) return emoji
  // A caller that couldn't place the workspace (findIndex → -1) still gets an icon.
  const i = index >= 0 ? index : 0
  return WORKSPACE_DEFAULT_EMOJIS[i % WORKSPACE_DEFAULT_EMOJIS.length]
}
