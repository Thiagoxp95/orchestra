import { useState, useRef, useEffect } from 'react'
import type { AppSettings, CustomAction } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'
import { ColorPicker } from './ColorPicker'
import { Toggle } from './Toggle'
import { textColor, isLightColor } from '../utils/color'

interface SettingsDialogProps {
  settings: AppSettings
  customActions: CustomAction[]
  wsColor: string
  onSaveSettings: (settings: AppSettings) => void
  onUpdateAction: (id: string, updates: Partial<CustomAction>) => void
  onDeleteAction: (id: string) => void
  onAddAction: (action: CustomAction) => void
  onUpdateWorkspaceColor: (color: string) => void
  onClose: () => void
}

export function SettingsDialog({
  settings,
  customActions,
  wsColor,
  onSaveSettings,
  onUpdateAction,
  onDeleteAction,
  onAddAction,
  onUpdateWorkspaceColor,
  onClose
}: SettingsDialogProps) {
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddAction, setShowAddAction] = useState(false)
  const [color, setColor] = useState(wsColor)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const colorPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showColorPicker) return
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColorPicker])

  const light = isLightColor(color)
  const txt = textColor(color)
  const subtleBg = light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
  const borderClr = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'
  const mutedTxt = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const inputBg = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'
  const inputBorder = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'
  const placeholderClr = light ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)'

  const handleSave = () => {
    onSaveSettings({ worktreesDir })
    if (color !== wsColor) onUpdateWorkspaceColor(color)
    onClose()
  }

  const handleSelectWorktreesDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorktreesDir(dir)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="rounded-xl p-6 w-[480px] shadow-2xl max-h-[80vh] flex flex-col"
        style={{ backgroundColor: color, border: `1px solid ${borderClr}` }}
      >
        <h2 className="text-lg font-semibold mb-4" style={{ color: txt }}>Settings</h2>

        {/* Workspace color */}
        <div className="mb-5">
          <label className="block text-sm mb-1.5" style={{ color: mutedTxt }}>Workspace color</label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="w-8 h-8 rounded-lg border-2 shrink-0 hover:scale-110 transition-transform"
              style={{ backgroundColor: color, borderColor: borderClr }}
            />
            {showColorPicker && (
              <div ref={colorPickerRef} className="absolute mt-40 z-10">
                <ColorPicker color={color} onChange={setColor} />
              </div>
            )}
            <span className="text-xs font-mono" style={{ color: mutedTxt }}>{color}</span>
          </div>
        </div>

        {/* Actions section */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium" style={{ color: txt }}>Actions</label>
            <button
              onClick={() => setShowAddAction(true)}
              className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: mutedTxt }}
            >
              + Add action
            </button>
          </div>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {customActions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                isEditing={editingId === action.id}
                txt={txt}
                mutedTxt={mutedTxt}
                subtleBg={subtleBg}
                borderClr={borderClr}
                inputBg={inputBg}
                inputBorder={inputBorder}
                placeholderClr={placeholderClr}
                onEdit={() => setEditingId(editingId === action.id ? null : action.id)}
                onUpdate={(updates) => onUpdateAction(action.id, updates)}
                onDelete={() => onDeleteAction(action.id)}
              />
            ))}
          </div>
        </div>

        {/* Worktrees dir */}
        <div className="mb-5">
          <label className="block text-sm mb-1" style={{ color: mutedTxt }}>Worktrees directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={worktreesDir}
              onChange={(e) => setWorktreesDir(e.target.value)}
              placeholder="Leave empty for ~/.orchestra/worktrees"
              className="flex-1 rounded-md px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt, '--tw-placeholder-opacity': 1 } as React.CSSProperties}
            />
            <button
              onClick={handleSelectWorktreesDir}
              className="px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
              style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: mutedTxt }}
            >
              Browse
            </button>
            {worktreesDir && (
              <button
                onClick={() => setWorktreesDir('')}
                className="px-2 py-2 text-xs rounded-md hover:opacity-80 transition-opacity"
                style={{ color: mutedTxt }}
                title="Reset to default (~/.orchestra/worktrees)"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
            style={{ color: mutedTxt }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
            style={{ backgroundColor: subtleBg, color: txt, border: `1px solid ${borderClr}` }}
          >
            Save
          </button>
        </div>
      </div>

      {showAddAction && (
        <AddActionDialog
          onSave={(action) => { onAddAction(action); setShowAddAction(false) }}
          onCancel={() => setShowAddAction(false)}
        />
      )}
    </div>
  )
}

function ActionRow({
  action,
  isEditing,
  txt,
  mutedTxt,
  subtleBg,
  borderClr,
  inputBg,
  inputBorder,
  placeholderClr,
  onEdit,
  onUpdate,
  onDelete
}: {
  action: CustomAction
  isEditing: boolean
  txt: string
  mutedTxt: string
  subtleBg: string
  borderClr: string
  inputBg: string
  inputBorder: string
  placeholderClr: string
  onEdit: () => void
  onUpdate: (updates: Partial<CustomAction>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(action.name)
  const [command, setCommand] = useState(action.command)
  const [keybinding, setKeybinding] = useState(action.keybinding)
  const [runOnWorktreeCreation, setRunOnWorktreeCreation] = useState(action.runOnWorktreeCreation ?? false)
  const [runOnWorktreeDestruction, setRunOnWorktreeDestruction] = useState(action.runOnWorktreeDestruction ?? false)
  const [singleSession, setSingleSession] = useState(action.singleSession ?? false)
  const [focusOnCreation, setFocusOnCreation] = useState(action.focusOnCreation !== false)
  const [runInBackground, setRunInBackground] = useState(action.runInBackground ?? false)
  const [actionType, setActionType] = useState<import('../../../shared/types').ActionType>(action.actionType ?? 'cli')

  const handleKeybindingKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Backspace') { setKeybinding(''); return }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
    const parts: string[] = []
    if (e.metaKey) parts.push('Cmd')
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
    setKeybinding(parts.join('+'))
  }

  const handleSave = () => {
    onUpdate({ name, command, keybinding, runOnWorktreeCreation, runOnWorktreeDestruction, singleSession, focusOnCreation, runInBackground, actionType })
    onEdit()
  }

  return (
    <div className="rounded-md" style={{ backgroundColor: subtleBg, border: `1px solid ${borderClr}` }}>
      {/* Collapsed row */}
      <div className="flex items-center gap-2.5 px-3 py-2 cursor-pointer" onClick={onEdit}>
        <DynamicIcon name={action.icon} size={16} color={mutedTxt} />
        <span className="text-sm flex-1 truncate" style={{ color: txt }}>{action.name}</span>
        {action.keybinding && (
          <span className="text-xs font-mono" style={{ color: mutedTxt }}>{action.keybinding}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="hover:opacity-100 transition-opacity text-xs"
          style={{ color: mutedTxt, opacity: isEditing ? 0.8 : 0 }}
          title="Delete"
        >
          ×
        </button>
      </div>
      {/* Expanded editor */}
      {isEditing && (
        <div className="px-3 pb-3 space-y-2 pt-2" style={{ borderTop: `1px solid ${borderClr}` }}>
          <div>
            <label className="block text-xs mb-0.5" style={{ color: mutedTxt }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded px-2 py-1.5 text-sm focus:outline-none"
              style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
            />
          </div>
          <div>
            <label className="block text-xs mb-0.5" style={{ color: mutedTxt }}>Type</label>
            <div className="flex gap-0.5 rounded p-0.5" style={{ backgroundColor: inputBg }}>
              {([
                { value: 'cli' as const, label: 'CLI' },
                { value: 'claude' as const, label: 'Claude' },
                { value: 'codex' as const, label: 'Codex' },
              ]).map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActionType(tab.value)}
                  className="flex-1 px-2 py-1 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: actionType === tab.value ? `${txt}20` : 'transparent',
                    color: actionType === tab.value ? txt : mutedTxt,
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs mb-0.5" style={{ color: mutedTxt }}>
              {actionType === 'cli' ? 'Command' : 'Prompt'}
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={actionType === 'cli' ? 'e.g. bun test' : 'e.g. Fix the failing tests'}
              className="w-full rounded px-2 py-1.5 text-sm focus:outline-none"
              style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
            />
          </div>
          <div>
            <label className="block text-xs mb-0.5" style={{ color: mutedTxt }}>Keybinding</label>
            <input
              type="text"
              value={keybinding}
              onKeyDown={handleKeybindingKeyDown}
              readOnly
              placeholder="Press shortcut"
              className="w-full rounded px-2 py-1.5 text-sm focus:outline-none cursor-pointer"
              style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
            />
          </div>
          {!action.isDefault && (
            <>
              <Toggle label="Run on worktree creation" value={runOnWorktreeCreation} onChange={setRunOnWorktreeCreation} txt={txt} mutedTxt={mutedTxt} bg={inputBg} />
              <Toggle label="Run on worktree destruction" value={runOnWorktreeDestruction} onChange={setRunOnWorktreeDestruction} txt={txt} mutedTxt={mutedTxt} bg={inputBg} />
              <Toggle label="Reuse single session" value={singleSession} onChange={setSingleSession} txt={txt} mutedTxt={mutedTxt} bg={inputBg} />
              <Toggle label="Run in background" value={runInBackground} onChange={setRunInBackground} txt={txt} mutedTxt={mutedTxt} bg={inputBg} />
              {!runInBackground && (
                <Toggle label="Focus on creation" value={focusOnCreation} onChange={setFocusOnCreation} txt={txt} mutedTxt={mutedTxt} bg={inputBg} />
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onEdit} className="text-xs hover:opacity-80" style={{ color: mutedTxt }}>Cancel</button>
            <button onClick={handleSave} className="text-xs hover:opacity-80" style={{ color: txt }}>Save</button>
          </div>
        </div>
      )}
    </div>
  )
}
