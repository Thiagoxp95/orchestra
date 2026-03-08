export function Toggle({ label, value, onChange, txt, mutedTxt, bg }: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  txt?: string
  mutedTxt?: string
  bg?: string
}) {
  const knobColor = txt ?? '#fff'
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded" style={{ backgroundColor: bg ?? 'rgba(255,255,255,0.05)' }}>
      <span className="text-xs" style={{ color: mutedTxt ?? '#9ca3af' }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          position: 'relative',
          width: 32,
          height: 16,
          borderRadius: 9999,
          backgroundColor: value ? knobColor + '66' : knobColor + '33',
          transition: 'background-color 150ms',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 16 : 2,
            width: 12,
            height: 12,
            borderRadius: 9999,
            backgroundColor: knobColor,
            transition: 'left 150ms',
          }}
        />
      </button>
    </div>
  )
}
