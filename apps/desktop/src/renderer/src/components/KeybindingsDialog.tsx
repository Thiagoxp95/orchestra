import { useState, useEffect } from 'react'
import { isLightColor, textColor } from '../utils/color'
import { Kbd } from './Kbd'
import { BUILTIN_SHORTCUTS, REFERENCE_SHORTCUTS, type BuiltinShortcut } from '../keybindings'
import type { CustomAction } from '../../../shared/types'

interface KeybindingsDialogProps {
  wsColor: string
  overrides: Record<string, string>
  customActions: CustomAction[]
  onSave: (overrides: Record<string, string>) => void
  onClose: () => void
}

export function KeybindingsDialog({
  wsColor,
  overrides,
  customActions,
  onSave,
  onClose,
}: KeybindingsDialogProps) {
  const [localOverrides, setLocalOverrides] = useState<Record<string, string>>({ ...overrides })
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingId) { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, editingId])

  const light = isLightColor(wsColor)
  const txt = textColor(wsColor)
  const subtleBg = light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
  const borderClr = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'
  const mutedTxt = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const inputBg = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'
  const inputBorder = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'

  const getEffective = (s: BuiltinShortcut) =>
    localOverrides[s.id] !== undefined ? localOverrides[s.id] : s.defaultKeybinding

  const isModified = (s: BuiltinShortcut) =>
    localOverrides[s.id] !== undefined && localOverrides[s.id] !== s.defaultKeybinding

  const handleKeybindingKeyDown = (id: string, defaultBinding: string, e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { setEditingId(null); return }
    if (e.key === 'Backspace') {
      setLocalOverrides((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setEditingId(null)
      return
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
    const parts: string[] = []
    if (e.metaKey) parts.push('Cmd')
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
    const binding = parts.join('+')
    if (binding === defaultBinding) {
      setLocalOverrides((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } else {
      setLocalOverrides((prev) => ({ ...prev, [id]: binding }))
    }
    setEditingId(null)
  }

  const handleSave = () => {
    onSave(localOverrides)
    onClose()
  }

  const handleResetAll = () => {
    setLocalOverrides({})
  }

  const categories = ['General', 'Sessions', 'Workspaces'] as const
  const hasChanges = JSON.stringify(localOverrides) !== JSON.stringify(overrides)
  const hasAnyOverrides = Object.keys(localOverrides).length > 0

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-xl w-[520px] shadow-2xl max-h-[80vh] flex flex-col"
        style={{ backgroundColor: wsColor, border: `1px solid ${borderClr}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-6 py-4">
          <h2 className="text-lg font-semibold flex-1" style={{ color: txt }}>Keyboard Shortcuts</h2>
          {hasAnyOverrides && (
            <button
              onClick={handleResetAll}
              className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: mutedTxt }}
            >
              Reset all
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5">
          {categories.map((cat) => {
            const shortcuts = BUILTIN_SHORTCUTS.filter((s) => s.category === cat)
            const refs = REFERENCE_SHORTCUTS.filter((s) => s.category === cat)
            if (shortcuts.length === 0 && refs.length === 0) return null

            return (
              <div key={cat}>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: mutedTxt }}>
                  {cat}
                </div>
                <div className="space-y-0.5">
                  {shortcuts.map((s) => {
                    const effective = getEffective(s)
                    const modified = isModified(s)
                    const isEditing = editingId === s.id

                    return (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg"
                        style={{ backgroundColor: isEditing ? subtleBg : undefined }}
                      >
                        <span className="text-sm flex-1" style={{ color: txt }}>{s.label}</span>
                        {modified && (
                          <button
                            onClick={() => {
                              setLocalOverrides((prev) => {
                                const next = { ...prev }
                                delete next[s.id]
                                return next
                              })
                            }}
                            className="text-[10px] hover:opacity-80 transition-opacity"
                            style={{ color: mutedTxt }}
                            title="Reset to default"
                          >
                            reset
                          </button>
                        )}
                        {isEditing ? (
                          <input
                            autoFocus
                            readOnly
                            placeholder="Press shortcut…"
                            className="w-[160px] text-right rounded-md px-2 py-1 text-xs font-mono focus:outline-none"
                            style={{
                              backgroundColor: inputBg,
                              border: `1px solid ${inputBorder}`,
                              color: txt,
                            }}
                            onKeyDown={(e) => handleKeybindingKeyDown(s.id, s.defaultKeybinding, e)}
                            onBlur={() => setEditingId(null)}
                          />
                        ) : (
                          <button
                            onClick={() => setEditingId(s.id)}
                            className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                            title="Click to change"
                          >
                            {effective ? (
                              <Kbd shortcut={effective} color={modified ? txt : mutedTxt} />
                            ) : (
                              <span className="text-xs italic" style={{ color: mutedTxt }}>none</span>
                            )}
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {refs.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg opacity-60"
                    >
                      <span className="text-sm flex-1" style={{ color: txt }}>{r.label}</span>
                      <span className="text-xs font-mono" style={{ color: mutedTxt }}>{r.keybinding}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Custom action shortcuts */}
          {customActions.some((a) => a.keybinding) && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: mutedTxt }}>
                Actions
              </div>
              <div className="space-y-0.5">
                {customActions.filter((a) => a.keybinding).map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-lg">
                    <span className="text-sm flex-1" style={{ color: txt }}>{a.name}</span>
                    <Kbd shortcut={a.keybinding} color={mutedTxt} />
                  </div>
                ))}
              </div>
              <p className="text-[10px] mt-2 px-3" style={{ color: mutedTxt }}>
                Action shortcuts can be changed in Settings → Actions.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 pb-5 pt-2 flex justify-end gap-2" style={{ borderTop: `1px solid ${borderClr}` }}>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
            style={{ color: mutedTxt }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
            style={{ backgroundColor: subtleBg, color: txt, border: `1px solid ${borderClr}` }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
