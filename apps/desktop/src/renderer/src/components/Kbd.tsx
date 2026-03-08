const KEY_MAP: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

export function Kbd({ shortcut, color }: { shortcut: string; color?: string }) {
  const parts = shortcut.split('+')

  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="text-[10px] opacity-40 mx-0.5" style={color ? { color } : undefined}>+</span>}
          <kbd
            className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1 rounded-md text-[11px] font-medium shadow-[0_1px_0_0_rgba(255,255,255,0.05)] ${color ? '' : 'bg-white/10 border border-white/10 text-white/70'}`}
            style={color ? { color, borderColor: `${color}33`, backgroundColor: `${color}15`, border: `1px solid ${color}33` } : undefined}
          >
            {KEY_MAP[part] ?? part}
          </kbd>
        </span>
      ))}
    </span>
  )
}
