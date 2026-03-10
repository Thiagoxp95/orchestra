import { useState, useRef, useEffect } from 'react'
import { IconPicker } from './IconPicker'
import { DynamicIcon } from './DynamicIcon'
import { Toggle } from './Toggle'
import { textColor, isLightColor } from '../utils/color'
import type { CustomAction, ActionType } from '../../../shared/types'

interface AddActionDialogProps {
  wsColor: string
  onSave: (action: CustomAction) => void
  onCancel: () => void
}

export function AddActionDialog({ wsColor, onSave, onCancel }: AddActionDialogProps) {
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
  const [printMode, setPrintMode] = useState(false)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const keybindingRef = useRef<HTMLInputElement>(null)

  const light = isLightColor(wsColor)
  const txt = textColor(wsColor)
  const borderClr = light ? 'rgba(0,0,0,0.15)' : `${txt}1a`
  const inputBg = light ? 'rgba(0,0,0,0.06)' : `${txt}0d`
  const inputBorder = light ? 'rgba(0,0,0,0.15)' : `${txt}1a`
  const inputFocusBorder = light ? 'rgba(0,0,0,0.3)' : `${txt}33`
  const toggleBg = light ? 'rgba(0,0,0,0.06)' : `${txt}0d`

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
      runInBackground,
      printMode: (actionType === 'claude' || actionType === 'codex') ? printMode : undefined
    })
  }

  const inputStyle: React.CSSProperties = {
    backgroundColor: inputBg,
    borderColor: inputBorder,
    color: txt,
  }

  const inputClass = 'w-full rounded-md px-3 py-2 text-sm border focus:outline-none transition-colors'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="rounded-xl p-6 w-[420px] shadow-2xl border" style={{ backgroundColor: wsColor, borderColor: borderClr }}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold" style={{ color: txt }}>Add Action</h2>
          <button onClick={onCancel} className="transition-opacity opacity-50 hover:opacity-100" style={{ color: txt }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
        <p className="text-sm mb-5 opacity-70" style={{ color: txt }}>
          Actions are project-scoped commands you can run from the sidebar or keybindings.
        </p>

        <div className="space-y-4">
          {/* Name + icon */}
          <div>
            <label className="block text-sm mb-1 opacity-70" style={{ color: txt }}>Name</label>
            <div className="flex gap-2">
              <button
                onClick={() => setShowIconPicker(true)}
                className="shrink-0 w-10 h-10 flex items-center justify-center rounded-md border transition-colors hover:opacity-80"
                style={{ backgroundColor: inputBg, borderColor: inputBorder }}
                title="Choose icon"
              >
                <DynamicIcon name={icon} size={18} color={txt} />
              </button>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Test"
                className={`flex-1 ${inputClass} placeholder:opacity-40`}
                style={inputStyle}
                onFocus={(e) => e.currentTarget.style.borderColor = inputFocusBorder}
                onBlur={(e) => e.currentTarget.style.borderColor = inputBorder}
              />
            </div>
          </div>

          {/* Keybinding */}
          <div>
            <label className="block text-sm mb-1 opacity-70" style={{ color: txt }}>Keybinding</label>
            <input
              ref={keybindingRef}
              type="text"
              value={keybinding}
              onKeyDown={handleKeybindingKeyDown}
              readOnly
              placeholder="Press shortcut"
              className={`${inputClass} cursor-pointer placeholder:opacity-40`}
              style={inputStyle}
              onFocus={(e) => e.currentTarget.style.borderColor = inputFocusBorder}
              onBlur={(e) => e.currentTarget.style.borderColor = inputBorder}
            />
            <p className="text-xs mt-1 opacity-60" style={{ color: txt }}>
              Press a shortcut. Use <kbd className="px-1 py-0.5 rounded text-xs" style={{ backgroundColor: inputBg, color: txt }}>Backspace</kbd> to clear.
            </p>
          </div>

          {/* Action type tabs */}
          <div>
            <label className="block text-sm mb-1 opacity-70" style={{ color: txt }}>Type</label>
            <div className="flex gap-1 rounded-md p-1" style={{ backgroundColor: inputBg }}>
              {([
                { value: 'cli' as const, label: 'CLI Command', icon: '__terminal__' },
                { value: 'claude' as const, label: 'Claude Code', icon: '__claude__' },
                { value: 'codex' as const, label: 'Codex', icon: '__openai__' },
              ]).map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActionType(tab.value)}
                  className="flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: actionType === tab.value ? `${txt}26` : 'transparent',
                    color: txt,
                    opacity: actionType === tab.value ? 1 : 0.55,
                  }}
                >
                  <DynamicIcon name={tab.icon} size={16} color={txt} />
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Command / Prompt */}
          <div>
            <label className="block text-sm mb-1 opacity-70" style={{ color: txt }}>
              {actionType === 'cli' ? 'Command' : 'Prompt'}
            </label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={actionType === 'cli' ? 'e.g. bun test' : 'e.g. Fix the failing tests'}
              rows={3}
              className={`${inputClass} resize-y placeholder:opacity-40`}
              style={inputStyle}
              onFocus={(e) => e.currentTarget.style.borderColor = inputFocusBorder}
              onBlur={(e) => e.currentTarget.style.borderColor = inputBorder}
            />
            {actionType === 'claude' && (
              <p className="text-xs mt-1 opacity-60" style={{ color: txt }}>
                Runs as <code className="px-1 py-0.5 rounded" style={{ backgroundColor: inputBg, color: txt }}>{printMode ? 'claude -p [prompt]' : 'claude [prompt]'}</code>. {printMode ? 'Prints the output and exits.' : 'The session stays attached to the terminal.'}
              </p>
            )}
            {actionType === 'codex' && (
              <p className="text-xs mt-1 opacity-60" style={{ color: txt }}>
                Runs as <code className="px-1 py-0.5 rounded" style={{ backgroundColor: inputBg, color: txt }}>{printMode ? 'codex -q [prompt]' : 'codex --full-auto [prompt]'}</code>. {printMode ? 'Prints the output and exits.' : 'The session stays attached to the terminal.'}
              </p>
            )}
          </div>

          {/* Interactive / Print mode toggle for Claude & Codex */}
          {(actionType === 'claude' || actionType === 'codex') && (
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm" style={{ color: txt }}>Interactive mode</span>
                <span
                  className="inline-flex items-center justify-center cursor-help"
                  title={
                    'Interactive: The agent stays running in the terminal. You can send follow-up messages and interact with it.\n\n' +
                    'Print: The agent processes the prompt, prints its output, and exits. Non-interactive, useful for one-shot tasks.'
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: txt, opacity: 0.4 }}>
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2" />
                    <text x="8" y="11.5" textAnchor="middle" fill="currentColor" fontSize="9" fontWeight="600" fontFamily="system-ui">i</text>
                  </svg>
                </span>
              </div>
              <div className="flex gap-0.5 rounded p-0.5" style={{ backgroundColor: toggleBg }}>
                <button
                  type="button"
                  onClick={() => setPrintMode(false)}
                  className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: !printMode ? `${txt}20` : 'transparent',
                    color: !printMode ? txt : `${txt}88`,
                  }}
                >
                  Interactive
                </button>
                <button
                  type="button"
                  onClick={() => setPrintMode(true)}
                  className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: printMode ? `${txt}20` : 'transparent',
                    color: printMode ? txt : `${txt}88`,
                  }}
                >
                  Print
                </button>
              </div>
            </div>
          )}

          {/* Toggles */}
          <Toggle label="Run on worktree creation" value={runOnWorktree} onChange={setRunOnWorktree} txt={txt} mutedTxt={txt} bg={toggleBg} />
          <Toggle label="Run on worktree destruction" value={runOnWorktreeDestruction} onChange={setRunOnWorktreeDestruction} txt={txt} mutedTxt={txt} bg={toggleBg} />
          <Toggle label="Reuse single session" value={singleSession} onChange={setSingleSession} txt={txt} mutedTxt={txt} bg={toggleBg} />
          <Toggle label="Run in background" value={runInBackground} onChange={setRunInBackground} txt={txt} mutedTxt={txt} bg={toggleBg} />
          {!runInBackground && (
            <Toggle label="Focus on creation" value={focusOnCreation} onChange={setFocusOnCreation} txt={txt} mutedTxt={txt} bg={toggleBg} />
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-md transition-colors opacity-70 hover:opacity-100"
            style={{ color: txt }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !command.trim()}
            className="px-4 py-2 text-sm rounded-md transition-colors disabled:opacity-40"
            style={{ backgroundColor: `${txt}1a`, color: txt }}
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
