export interface BuiltinShortcut {
  id: string
  label: string
  category: 'General' | 'Sessions' | 'Workspaces'
  defaultKeybinding: string
  global: boolean
}

export const BUILTIN_SHORTCUTS: BuiltinShortcut[] = [
  { id: 'toggle-sidebar', label: 'Toggle sidebar', category: 'General', defaultKeybinding: 'Cmd+B', global: true },
  { id: 'toggle-diff', label: 'Toggle diff panel', category: 'General', defaultKeybinding: 'Cmd+Shift+D', global: true },
  { id: 'cycle-sessions-up', label: 'Previous session', category: 'Sessions', defaultKeybinding: 'Cmd+ArrowUp', global: true },
  { id: 'cycle-sessions-down', label: 'Next session', category: 'Sessions', defaultKeybinding: 'Cmd+ArrowDown', global: true },
  { id: 'reorder-session-up', label: 'Move session up', category: 'Sessions', defaultKeybinding: 'Cmd+Shift+ArrowUp', global: true },
  { id: 'reorder-session-down', label: 'Move session down', category: 'Sessions', defaultKeybinding: 'Cmd+Shift+ArrowDown', global: true },
  { id: 'vim-session-up', label: 'Previous session (vim)', category: 'Sessions', defaultKeybinding: 'Ctrl+K', global: false },
  { id: 'vim-session-down', label: 'Next session (vim)', category: 'Sessions', defaultKeybinding: 'Ctrl+J', global: false },
  { id: 'vim-session-left', label: 'Previous session left (vim)', category: 'Sessions', defaultKeybinding: 'Ctrl+H', global: false },
  { id: 'vim-session-right', label: 'Next session right (vim)', category: 'Sessions', defaultKeybinding: 'Ctrl+L', global: false },
  { id: 'toggle-maestro', label: 'Toggle Maestro Mode', category: 'General', defaultKeybinding: 'Cmd+Shift+M', global: true },
  { id: 'cycle-workspaces-maestro-left', label: 'Previous workspace (keep view)', category: 'Workspaces', defaultKeybinding: 'Cmd+Shift+ArrowLeft', global: true },
  { id: 'cycle-workspaces-maestro-right', label: 'Next workspace (keep view)', category: 'Workspaces', defaultKeybinding: 'Cmd+Shift+ArrowRight', global: true },
]

/** Reference-only shortcuts that are patterns (1-9) and not individually configurable */
export const REFERENCE_SHORTCUTS = [
  { label: 'Switch to workspace 1–9', keybinding: 'Cmd+Shift+1…9', category: 'Workspaces' as const },
  { label: 'Switch to worktree 1–9', keybinding: 'Cmd+1…9', category: 'Workspaces' as const },
  { label: 'Switch to session 1–9', keybinding: 'Ctrl+1…9', category: 'Sessions' as const },
]

export function matchesKeybinding(e: KeyboardEvent, keybinding: string): boolean {
  if (!keybinding) return false
  const parts = keybinding.split('+')
  const key = parts[parts.length - 1]
  const needCmd = parts.includes('Cmd')
  const needCtrl = parts.includes('Ctrl')
  const needAlt = parts.includes('Alt')
  const needShift = parts.includes('Shift')

  const keyMatch = key.length === 1
    ? e.key.toUpperCase() === key.toUpperCase()
    : e.key === key

  return (
    keyMatch &&
    e.metaKey === needCmd &&
    e.ctrlKey === needCtrl &&
    e.altKey === needAlt &&
    e.shiftKey === needShift
  )
}

export function getBinding(
  id: string,
  overrides?: Record<string, string>
): string {
  const override = overrides?.[id]
  if (override !== undefined) return override
  const shortcut = BUILTIN_SHORTCUTS.find((s) => s.id === id)
  return shortcut?.defaultKeybinding ?? ''
}
