const KEY_MAP: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
}

export function Kbd({ shortcut }: { shortcut: string }) {
  const parts = shortcut.split('+')

  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="text-[10px] opacity-40 mx-0.5">+</span>}
          <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1 rounded-md text-[11px] font-medium bg-white/10 border border-white/10 text-white/70 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
            {KEY_MAP[part] ?? part}
          </kbd>
        </span>
      ))}
    </span>
  )
}
