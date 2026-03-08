import { useState, useRef, useEffect } from 'react'
import { IconPicker } from './IconPicker'
import { DynamicIcon } from './DynamicIcon'
import { Toggle } from './Toggle'
import type { CustomAction, ActionType } from '../../../shared/types'

interface AddActionDialogProps {
  onSave: (action: CustomAction) => void
  onCancel: () => void
}

export function AddActionDialog({ onSave, onCancel }: AddActionDialogProps) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('PlayIcon')
  const [command, setCommand] = useState('')
  const [keybinding, setKeybinding] = useState('')
  const [runOnWorktree, setRunOnWorktree] = useState(false)
  const [runOnWorktreeDestruction, setRunOnWorktreeDestruction] = useState(false)
  const [singleSession, setSingleSession] = useState(false)
  const [focusOnCreation, setFocusOnCreation] = useState(true)
  const [runInBackground, setRunInBackground] = useState(false)
  const [actionType, setActionType] = useState<ActionType>('cli')
  const [showIconPicker, setShowIconPicker] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const keybindingRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const handleKeybindingKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Backspace') {
      setKeybinding('')
      return
    }
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
    if (!name.trim() || !command.trim()) return
    onSave({
      id: crypto.randomUUID(),
      name: name.trim(),
      icon,
      command: command.trim(),
      keybinding,
      actionType,
      runOnWorktreeCreation: runOnWorktree,
      runOnWorktreeDestruction,
      singleSession: runInBackground ? false : singleSession,
      focusOnCreation: runInBackground ? false : focusOnCreation,
      runInBackground
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e2e] rounded-xl p-6 w-[420px] shadow-2xl border border-white/10">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-white">Add Action</h2>
          <button onClick={onCancel} className="text-gray-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-5">
          Actions are project-scoped commands you can run from the sidebar or keybindings.
        </p>

        <div className="space-y-4">
          {/* Name + icon */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <div className="flex gap-2">
              <button
                onClick={() => setShowIconPicker(true)}
                className="shrink-0 w-10 h-10 flex items-center justify-center rounded-md bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                title="Choose icon"
              >
                <DynamicIcon name={icon} size={18} color="white" />
              </button>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Test"
                className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
              />
            </div>
          </div>

          {/* Keybinding */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Keybinding</label>
            <input
              ref={keybindingRef}
              type="text"
              value={keybinding}
              onKeyDown={handleKeybindingKeyDown}
              readOnly
              placeholder="Press shortcut"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20 cursor-pointer"
            />
            <p className="text-xs text-gray-500 mt-1">Press a shortcut. Use <kbd className="px-1 py-0.5 bg-white/10 rounded text-gray-400">Backspace</kbd> to clear.</p>
          </div>

          {/* Action type tabs */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Type</label>
            <div className="flex gap-1 bg-white/5 rounded-md p-1">
              {([
                { value: 'cli' as const, label: 'CLI Command' },
                { value: 'claude' as const, label: 'Claude Code' },
                { value: 'codex' as const, label: 'Codex' },
              ]).map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActionType(tab.value)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                    actionType === tab.value
                      ? 'bg-white/15 text-white'
                      : 'text-gray-400 hover:text-gray-300'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Command / Prompt */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {actionType === 'cli' ? 'Command' : 'Prompt'}
            </label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={actionType === 'cli' ? 'e.g. bun test' : 'e.g. Fix the failing tests'}
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20 resize-y"
            />
            {actionType === 'claude' && (
              <p className="text-xs text-gray-500 mt-1">
                Runs with <code className="px-1 py-0.5 bg-white/10 rounded text-gray-400">-p</code> (non-interactive print mode). Claude will answer and exit — no interactive session.
              </p>
            )}
            {actionType === 'codex' && (
              <p className="text-xs text-gray-500 mt-1">
                Runs with <code className="px-1 py-0.5 bg-white/10 rounded text-gray-400">codex exec</code> (non-interactive). Codex will execute and exit — no interactive session.
              </p>
            )}
          </div>

          {/* Run on worktree creation */}
          <Toggle label="Run on worktree creation" value={runOnWorktree} onChange={setRunOnWorktree} />

          {/* Run on worktree destruction */}
          <Toggle label="Run on worktree destruction" value={runOnWorktreeDestruction} onChange={setRunOnWorktreeDestruction} />

          {/* Reuse single session */}
          <Toggle label="Reuse single session" value={singleSession} onChange={setSingleSession} />

          {/* Run in background */}
          <Toggle label="Run in background" value={runInBackground} onChange={setRunInBackground} />

          {/* Focus on creation */}
          {!runInBackground && (
            <Toggle label="Focus on creation" value={focusOnCreation} onChange={setFocusOnCreation} />
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white rounded-md hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !command.trim()}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-500 transition-colors disabled:opacity-50"
          >
            Save action
          </button>
        </div>
      </div>

      {showIconPicker && (
        <IconPicker
          value={icon}
          onChange={setIcon}
          onClose={() => setShowIconPicker(false)}
        />
      )}
    </div>
  )
}
