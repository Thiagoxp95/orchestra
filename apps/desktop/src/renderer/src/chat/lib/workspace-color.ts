// Per-workspace tinting for the chat overlay.
//
// The rest of this app tints itself by passing `workspace.color` straight into
// inline styles (see utils/color.ts and the Sidebar/NavBar components). The chat
// pane is built on the token ladder ported from the web, so instead of
// restyling every row it re-derives those tokens from the workspace color and
// sets them on the pane's own root — every `bg-surface-raised` /
// `text-muted-foreground` / `border-border` inside then resolves to the
// workspace's palette. Same derivation as the web's chromeVars, scoped to the
// overlay rather than :root because only the chat uses these tokens here.

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

/** Primary text color for content on the given background. */
export function textColor(hex: string): string {
  return isLightColor(hex) ? '#1a1a1a' : '#ffffff'
}

/**
 * The chat tokens derived from a workspace color, as an inline style object.
 * Null for no workspace, where the stylesheet's dark defaults already apply.
 *
 * `--background` is the raw workspace color, NOT the darkened one the pane
 * paints: the glass composer mixes this token down to 80% over the painted
 * surface, and tinting it with the already-darkened value would double the
 * darkening. Same split the web has between chromeVars and terminalBg.
 */
export function chatScopeVars(color?: string | null): React.CSSProperties | null {
  if (!color) return null
  const fg = textColor(color)
  const overlay = (alpha: number) =>
    isLightColor(color) ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`
  return {
    '--background': color,
    '--foreground': fg,
    // Subtle divider: translucent foreground (hex-alpha ~13%).
    '--border': `${fg}22`,
    // Muted text = translucent foreground (~60%), matching the app's opacity trick.
    '--muted-foreground': `${fg}99`,
    '--accent': overlay(0.08),
    '--accent-foreground': fg,
  } as React.CSSProperties
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** The surface the terminal paints — the chat overlay matches it so flipping
 *  between the two views doesn't change the sheet underneath. */
export function terminalBg(color?: string | null): string {
  if (!color) return '#1a1a2e'
  const [h, s, l] = hexToHsl(color)
  return hslToHex(h, s, Math.max(l - 5, 0))
}
