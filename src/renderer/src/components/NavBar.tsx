import { useState, useRef, useEffect } from 'react'
import { Settings01Icon } from 'hugeicons-react'
import { useAppStore } from '../store/app-store'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { SettingsDialog } from './SettingsDialog'
import { textColor, mutedTextColor, iconColor } from '../utils/color'

export function NavBar() {
  const [showDialog, setShowDialog] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const sortedWorkspaces = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const txtColor = textColor(wsColor)
  const mutColor = mutedTextColor(wsColor)
  const icoColor = iconColor(wsColor)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    if (showDropdown) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [showDropdown])

  const handleCreateWorkspace = (name: string, color: string, rootDir: string) => {
    const workspaceId = createWorkspace(name, color, rootDir)
    const workspace = useAppStore.getState().workspaces[workspaceId]
    if (workspace && workspace.sessionIds[0]) {
      window.electronAPI.createTerminal(workspace.sessionIds[0], { cwd: rootDir })
    }
    setShowDialog(false)
  }

  const handleDeleteWorkspace = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const workspace = workspaces[id]
    if (workspace) {
      for (const sid of workspace.sessionIds) {
        window.electronAPI.killTerminal(sid)
      }
    }
    deleteWorkspace(id)
    if (sortedWorkspaces.length <= 1) setShowDropdown(false)
  }

  const handleSelectWorkspace = (id: string) => {
    setActiveWorkspace(id)
    setShowDropdown(false)
  }

  return (
    <>
      <div
        className="flex items-center justify-center px-2 h-11 transition-colors duration-300 relative"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          ref={dropdownRef}
          className="relative flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Workspace selector button */}
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-white/10 transition-colors"
          >
            {activeWorkspace ? (
              <>
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: activeWorkspace.color }}
                />
                <span className="text-sm font-medium truncate max-w-[200px]" style={{ color: txtColor }}>
                  {activeWorkspace.name}
                </span>
              </>
            ) : (
              <span className="text-sm" style={{ color: mutColor }}>Select workspace</span>
            )}
            <svg
              className={`w-3.5 h-3.5 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
              style={{ color: mutColor }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Dropdown */}
          {showDropdown && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-56 bg-[#1e1e2e] rounded-lg shadow-xl border border-white/10 py-1 z-50">
              {sortedWorkspaces.map((ws) => (
                <div
                  key={ws.id}
                  onClick={() => handleSelectWorkspace(ws.id)}
                  className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    ws.id === activeWorkspaceId
                      ? 'bg-white/10 text-white'
                      : 'text-gray-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: ws.color }}
                  />
                  <span className="text-sm truncate flex-1">{ws.name}</span>
                  <span
                    onClick={(e) => handleDeleteWorkspace(ws.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity text-xs"
                  >
                    ×
                  </span>
                </div>
              ))}
              {/* New workspace option */}
              <div
                onClick={() => { setShowDropdown(false); setShowDialog(true) }}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer text-gray-400 hover:bg-white/5 hover:text-white transition-colors border-t border-white/5 mt-1 pt-2"
              >
                <span className="text-sm">+</span>
                <span className="text-sm">New workspace</span>
              </div>
            </div>
          )}
        </div>

        {/* Settings gear icon */}
        <button
          onClick={() => setShowSettings(true)}
          className="absolute right-3 transition-colors hover:opacity-80"
          style={{ color: icoColor }}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Settings01Icon size={18} />
        </button>
      </div>

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onSave={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showDialog && (
        <CreateWorkspaceDialog
          onConfirm={handleCreateWorkspace}
          onCancel={() => setShowDialog(false)}
        />
      )}
    </>
  )
}
