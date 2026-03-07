import { useState } from 'react'
import type { AppSettings } from '../../../shared/types'

interface SettingsDialogProps {
  settings: AppSettings
  onSave: (settings: AppSettings) => void
  onClose: () => void
}

export function SettingsDialog({ settings, onSave, onClose }: SettingsDialogProps) {
  const [claudeCommand, setClaudeCommand] = useState(settings.claudeCommand)
  const [codexCommand, setCodexCommand] = useState(settings.codexCommand)
  const [terminalCommand, setTerminalCommand] = useState(settings.terminalCommand)

  const handleSave = () => {
    onSave({ claudeCommand, codexCommand, terminalCommand })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e2e] rounded-xl p-6 w-[420px] shadow-2xl border border-white/10">
        <h2 className="text-lg font-semibold text-white mb-4">Settings</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Claude command</label>
            <input
              type="text"
              value={claudeCommand}
              onChange={(e) => setClaudeCommand(e.target.value)}
              placeholder="e.g. claude"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Codex command</label>
            <input
              type="text"
              value={codexCommand}
              onChange={(e) => setCodexCommand(e.target.value)}
              placeholder="e.g. codex"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Terminal command</label>
            <input
              type="text"
              value={terminalCommand}
              onChange={(e) => setTerminalCommand(e.target.value)}
              placeholder="e.g. zsh (leave empty for default shell)"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
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
    </div>
  )
}
