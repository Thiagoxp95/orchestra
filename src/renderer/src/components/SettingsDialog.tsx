import { useState } from 'react'
import type { AppSettings, CustomAction } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'

interface SettingsDialogProps {
  settings: AppSettings
  customActions: CustomAction[]
  onSaveSettings: (settings: AppSettings) => void
  onUpdateAction: (id: string, updates: Partial<CustomAction>) => void
  onDeleteAction: (id: string) => void
  onAddAction: (action: CustomAction) => void
  onClose: () => void
}

export function SettingsDialog({
  settings,
  customActions,
  onSaveSettings,
  onUpdateAction,
  onDeleteAction,
  onAddAction,
  onClose
}: SettingsDialogProps) {
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddAction, setShowAddAction] = useState(false)

  const handleSave = () => {
    onSaveSettings({ worktreesDir })
    onClose()
  }

  const handleSelectWorktreesDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorktreesDir(dir)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e2e] rounded-xl p-6 w-[480px] shadow-2xl border border-white/10 max-h-[80vh] flex flex-col">
        <h2 className="text-lg font-semibold text-white mb-4">Settings</h2>

        {/* Actions section */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-300">Actions</label>
            <button
              onClick={() => setShowAddAction(true)}
              className="text-xs text-gray-400 hover:text-white transition-colors"
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
                onEdit={() => setEditingId(editingId === action.id ? null : action.id)}
                onUpdate={(updates) => onUpdateAction(action.id, updates)}
                onDelete={() => onDeleteAction(action.id)}
              />
            ))}
          </div>
        </div>

        {/* Worktrees dir */}
        <div className="mb-5">
          <label className="block text-sm text-gray-400 mb-1">Worktrees directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={worktreesDir}
              onChange={(e) => setWorktreesDir(e.target.value)}
              placeholder="Leave empty for ~/.orchestra/worktrees"
              className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
            />
            <button
              onClick={handleSelectWorktreesDir}
              className="px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white rounded-md hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-white/10 text-white rounded-md hover:bg-white/20 transition-colors"
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
  onEdit,
  onUpdate,
  onDelete
}: {
  action: CustomAction
  isEditing: boolean
  onEdit: () => void
  onUpdate: (updates: Partial<CustomAction>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(action.name)
  const [command, setCommand] = useState(action.command)
  const [keybinding, setKeybinding] = useState(action.keybinding)
  const [singleSession, setSingleSession] = useState(action.singleSession ?? false)
  const [focusOnCreation, setFocusOnCreation] = useState(action.focusOnCreation !== false)

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
    onUpdate({ name, command, keybinding, singleSession, focusOnCreation })
    onEdit()
  }

  return (
    <div className="rounded-md bg-white/5 border border-white/5">
      {/* Collapsed row */}
      <div className="flex items-center gap-2.5 px-3 py-2 cursor-pointer" onClick={onEdit}>
        <DynamicIcon name={action.icon} size={16} color="#9ca3af" />
        <span className="text-sm text-white flex-1 truncate">{action.name}</span>
        {action.keybinding && (
          <span className="text-xs text-gray-500 font-mono">{action.keybinding}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="text-gray-600 hover:text-red-400 transition-colors text-xs opacity-0 group-hover:opacity-100"
          title="Delete"
          style={{ opacity: isEditing ? 1 : undefined }}
        >
          ×
        </button>
      </div>
      {/* Expanded editor */}
      {isEditing && (
        <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
          <div>
            <label className="block text-xs text-gray-500 mb-0.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-0.5">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. bun test"
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-0.5">Keybinding</label>
            <input
              type="text"
              value={keybinding}
              onKeyDown={handleKeybindingKeyDown}
              readOnly
              placeholder="Press shortcut"
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-white/20 cursor-pointer"
            />
          </div>
          {!action.isDefault && (
            <>
              <div className="flex items-center justify-between py-1.5 px-2 bg-white/5 rounded">
                <span className="text-xs text-gray-400">Reuse single session</span>
                <button
                  onClick={() => setSingleSession(!singleSession)}
                  className={`relative w-8 h-4 rounded-full transition-colors ${
                    singleSession ? 'bg-indigo-500' : 'bg-white/20'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      singleSession ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between py-1.5 px-2 bg-white/5 rounded">
                <span className="text-xs text-gray-400">Focus on creation</span>
                <button
                  onClick={() => setFocusOnCreation(!focusOnCreation)}
                  className={`relative w-8 h-4 rounded-full transition-colors ${
                    focusOnCreation ? 'bg-indigo-500' : 'bg-white/20'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                      focusOnCreation ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onEdit} className="text-xs text-gray-400 hover:text-white">Cancel</button>
            <button onClick={handleSave} className="text-xs text-indigo-400 hover:text-indigo-300">Save</button>
          </div>
        </div>
      )}
    </div>
  )
}
