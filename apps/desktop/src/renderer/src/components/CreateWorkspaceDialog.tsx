import { useState, useEffect } from 'react'
import { ColorPicker } from './ColorPicker'
import { EmojiPicker } from './EmojiPicker'

interface CreateWorkspaceDialogProps {
  onConfirm: (name: string, color: string, rootDir: string, emoji?: string) => void
  onCancel: () => void
}

export function CreateWorkspaceDialog({ onConfirm, onCancel }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [rootDir, setRootDir] = useState('')
  const [emoji, setEmoji] = useState<string | undefined>(undefined)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() && rootDir) {
      onConfirm(name.trim(), color, rootDir, emoji)
    }
  }

  const handleSelectDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setRootDir(dir)
  }

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <form onSubmit={handleSubmit} className="bg-[#1e1e2e] rounded-lg p-6 w-96 shadow-xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-white text-lg font-semibold mb-4">New Workspace</h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          autoFocus
          className="w-full bg-[#2a2a3e] text-white px-3 py-2 rounded mb-4 outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="mb-4">
          <button
            type="button"
            onClick={handleSelectDir}
            className="w-full bg-[#2a2a3e] text-left px-3 py-2 rounded hover:bg-[#353550] transition-colors"
          >
            {rootDir ? (
              <span className="text-white text-sm truncate block">{rootDir}</span>
            ) : (
              <span className="text-gray-500 text-sm">Select root directory...</span>
            )}
          </button>
        </div>
        <div className="mb-4">
          <label className="block text-sm text-gray-400 mb-2">Emoji</label>
          <EmojiPicker value={emoji} onChange={setEmoji} />
        </div>
        <ColorPicker color={color} onChange={setColor} />
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || !rootDir} className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 transition-colors">
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
