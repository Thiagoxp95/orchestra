// Relative luminance per WCAG 2.0
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

// Returns true if the background is light (text should be dark)
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.4
}

// Primary text color for content on the workspace background
export function textColor(hex: string): string {
  return isLightColor(hex) ? '#1a1a1a' : '#ffffff'
}

// Muted/secondary text color
export function mutedTextColor(hex: string): string {
  return isLightColor(hex) ? '#555555' : '#9ca3af'
}

// Icon color (same logic as muted)
export function iconColor(hex: string): string {
  return isLightColor(hex) ? '#444444' : '#9ca3af'
}
