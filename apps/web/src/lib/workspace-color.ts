// Per-workspace chrome tinting for the web mirror, ported from the desktop.
//
// The desktop tints its whole UI from `workspace.color`: background = the color,
// foreground = textColor(color) (black or white by luminance), and borders / hover
// / active overlays derived from that (see apps/desktop .../utils/color.ts and the
// Sidebar/App/NavBar components). The web app is built on shadcn tokens, so instead
// of restyling every component we re-derive the shadcn CSS variables from the active
// workspace color and set them on :root — every `bg-sidebar`/`text-foreground`/
// `border-*` class then re-resolves to the workspace's palette automatically.

// Relative luminance per WCAG 2.0.
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** True when the background is light enough that text/overlays should be dark. */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.4
}

/** Primary text color for content on the given background (matches the desktop). */
export function textColor(hex: string): string {
  return isLightColor(hex) ? '#1a1a1a' : '#ffffff'
}

/**
 * The workspace color at partial strength, for surfaces that only want a hint of
 * it — the session overview's cards, where a dozen workspaces share one dark
 * screen and a full-strength tint each would be unreadable. Parsed rather than
 * handed to `color-mix` so it composites against whatever is behind it.
 */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 'transparent'
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * The shadcn CSS variables we override per workspace. Kept as a constant so the
 * caller can cleanly remove exactly these (restoring the default dark theme) when
 * no workspace is active, without disturbing unrelated custom properties.
 */
export const CHROME_VAR_KEYS = [
  '--background',
  '--foreground',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-border',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-ring',
  '--border',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
] as const

/**
 * Derive the shadcn chrome variables from a workspace color, or null when there is
 * no active workspace (caller removes CHROME_VAR_KEYS to fall back to the dark theme).
 * Background = the color, foreground = textColor(color); borders and hover/active
 * overlays use translucent foreground / luminance-gated black-or-white, exactly like
 * the desktop's `${txtColor}15` and isLightColor-gated rgba overlays.
 */
export function chromeVars(color?: string | null): Record<string, string> | null {
  if (!color) return null
  const fg = textColor(color)
  const overlay = (alpha: number) =>
    isLightColor(color) ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`
  return {
    '--background': color,
    '--foreground': fg,
    '--sidebar': color,
    '--sidebar-foreground': fg,
    // Subtle divider: translucent foreground (hex-alpha ~13%).
    '--sidebar-border': `${fg}22`,
    // Hover / active row: a faint darken-or-lighten over the workspace color.
    '--sidebar-accent': overlay(0.1),
    '--sidebar-accent-foreground': fg,
    '--sidebar-ring': fg,
    '--border': `${fg}22`,
    // Muted text = translucent foreground (~60%), matching the desktop's opacity trick.
    '--muted-foreground': `${fg}99`,
    '--accent': overlay(0.08),
    '--accent-foreground': fg,
  }
}
