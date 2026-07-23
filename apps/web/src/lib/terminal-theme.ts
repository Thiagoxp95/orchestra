// Derive the xterm terminal theme from a workspace color, matching the desktop.
// The desktop uses `darkenColor(workspace.color)` as the terminal background and
// `textColor(...)` for foreground/cursor (see apps/desktop .../TerminalArea.tsx and
// hooks/useTerminal.ts). The mirror must apply the identical derivation so the web
// terminal recolors per workspace exactly like the desktop.

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

// Relative luminance per WCAG 2.0.
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

// Primary text color for content on the given background.
function textColor(hex: string): string {
  return luminance(hex) > 0.4 ? '#1a1a1a' : '#ffffff'
}

// Slightly darken the workspace color for use as the terminal background.
function darkenColor(hex: string): string {
  const [h, s, l] = hexToHsl(hex)
  return hslToHex(h, s, Math.max(l - 5, 0))
}

/** Fallback used when no workspace color is available (matches the desktop default). */
export const DEFAULT_TERMINAL_BG = '#1a1a2e'

/** The darkened terminal background for a workspace color (or the default). */
export function terminalBg(color?: string): string {
  return color ? darkenColor(color) : DEFAULT_TERMINAL_BG
}

/** xterm ITheme derived from a workspace color, identical to the desktop's. */
export function terminalTheme(color?: string): {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
} {
  const bg = terminalBg(color)
  const fg = textColor(bg)
  return { background: bg, foreground: fg, cursor: fg, cursorAccent: bg }
}
