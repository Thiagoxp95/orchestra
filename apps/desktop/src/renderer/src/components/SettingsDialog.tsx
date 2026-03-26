import { useState, useEffect } from 'react'
import type { AppSettings, CustomAction, RepositoryWorkspaceSettings, SupersetWorktree } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'
import { AddActionDialog } from './AddActionDialog'
import { IconPicker } from './IconPicker'
import { ColorPicker } from './ColorPicker'
import { EmojiPicker } from './EmojiPicker'
import { Toggle } from './Toggle'
import { textColor, isLightColor } from '../utils/color'
import defaultSoundUrl from '../assets/sounds/default-notification.mp3'

type SettingsPage = 'index' | 'appearance' | 'notifications' | 'actions' | 'repository' | 'worktrees' | 'linear' | 'interruption'

interface SettingsDialogProps {
  settings: AppSettings
  customActions: CustomAction[]
  wsColor: string
  wsEmoji?: string
  workspaceId: string
  repositorySettingsEnabled: boolean
  notificationSound?: string
  questionNotificationSound?: string
  onSaveSettings: (settings: AppSettings) => void
  onSaveRepositorySettings: (settings: RepositoryWorkspaceSettings | null) => Promise<{ success: boolean; error?: string }>
  onUpdateAction: (id: string, updates: Partial<CustomAction>) => void
  onDeleteAction: (id: string) => void
  onAddAction: (action: CustomAction) => void
  onUpdateWorkspaceColor: (color: string) => void
  onUpdateWorkspaceEmoji: (emoji: string) => void
  onUpdateNotificationSound: (sound: string | undefined) => void
  onUpdateQuestionNotificationSound: (sound: string | undefined) => void
  workspaceRootDir: string | null
  existingTreePaths: string[]
  onImportWorktrees: (paths: string[]) => void
  worktrees?: { rootDir: string; label: string }[]
  linearConfig?: { apiKey: string; teamId: string; teamName: string }
  onSaveLinearConfig: (config: { apiKey: string; teamId: string; teamName: string } | undefined) => void
  interruptionMode?: boolean
  interruptionPosition?: import('../../../shared/types').InterruptionPosition
  onUpdateInterruptionMode: (enabled: boolean) => void
  onUpdateInterruptionPosition: (position: import('../../../shared/types').InterruptionPosition) => void
  onClose: () => void
}

export function SettingsDialog({
  settings,
  customActions,
  wsColor,
  wsEmoji,
  workspaceId,
  repositorySettingsEnabled,
  notificationSound,
  questionNotificationSound,
  onSaveSettings,
  onSaveRepositorySettings,
  onUpdateAction,
  onDeleteAction,
  onAddAction,
  onUpdateWorkspaceColor,
  onUpdateWorkspaceEmoji,
  onUpdateNotificationSound,
  onUpdateQuestionNotificationSound,
  workspaceRootDir,
  existingTreePaths,
  onImportWorktrees,
  worktrees,
  linearConfig,
  onSaveLinearConfig,
  interruptionMode,
  interruptionPosition,
  onUpdateInterruptionMode,
  onUpdateInterruptionPosition,
  onClose
}: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>('index')
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddAction, setShowAddAction] = useState(false)
  const [editingAction, setEditingAction] = useState<CustomAction | null>(null)
  const [color, setColor] = useState(wsColor)
  const [emoji, setEmoji] = useState<string | undefined>(wsEmoji)
  const [repoSettingsEnabled, setRepoSettingsEnabled] = useState(repositorySettingsEnabled)
  const [soundPath, setSoundPath] = useState<string | undefined>(notificationSound)
  const [questionSoundPath, setQuestionSoundPath] = useState<string | undefined>(questionNotificationSound)
  const [supersetWorktrees, setSupersetWorktrees] = useState<SupersetWorktree[]>([])
  const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set())
  const [importLoading, setImportLoading] = useState(false)
  const [importDone, setImportDone] = useState(false)
  const [linearApiKey, setLinearApiKey] = useState('')
  const [linearTeams, setLinearTeams] = useState<{ id: string; name: string; key: string }[]>([])
  const [linearSelectedTeam, setLinearSelectedTeam] = useState<string>(linearConfig?.teamId ?? '')
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  const [linearConnected, setLinearConnected] = useState(!!linearConfig)
  const [interruptionEnabled, setInterruptionEnabled] = useState(interruptionMode ?? false)
  const [interruptionPos, setInterruptionPos] = useState<'bottom-left' | 'bottom-right' | 'custom'>(
    typeof interruptionPosition === 'object' ? 'custom' :
    interruptionPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right'
  )
  const [customX, setCustomX] = useState(typeof interruptionPosition === 'object' ? interruptionPosition.x : 0)
  const [customY, setCustomY] = useState(typeof interruptionPosition === 'object' ? interruptionPosition.y : 0)

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const light = isLightColor(color)
  const txt = textColor(color)
  const subtleBg = light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
  const borderClr = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'
  const mutedTxt = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const inputBg = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'
  const inputBorder = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'
  const placeholderClr = light ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)'

  const handleSave = async () => {
    const sharedSettings: RepositoryWorkspaceSettings = {
      version: 1,
      color,
      customActions: customActions.map((action) => ({ ...action })),
    }
    const repositoryResult = await onSaveRepositorySettings(
      repoSettingsEnabled ? sharedSettings : null,
    )
    if (!repositoryResult.success) {
      window.alert(`Failed to update repository settings:\n${repositoryResult.error ?? 'Unknown error'}`)
      return
    }
    onSaveSettings({ worktreesDir })
    if (color !== wsColor) onUpdateWorkspaceColor(color)
    if (emoji !== wsEmoji) onUpdateWorkspaceEmoji(emoji ?? '')
    if (soundPath !== notificationSound) onUpdateNotificationSound(soundPath)
    if (questionSoundPath !== questionNotificationSound) onUpdateQuestionNotificationSound(questionSoundPath)
    onClose()
  }

  const handleSelectWorktreesDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorktreesDir(dir)
  }

  const previewSound = async (path: string | undefined) => {
    let url: string
    if (path) {
      const dataUrl = await window.electronAPI.readFileAsDataUrl(path)
      url = dataUrl ?? defaultSoundUrl
    } else {
      url = defaultSoundUrl
    }
    const audio = new Audio(url)
    audio.volume = 0.5
    await audio.play()
  }

  const handleLinearKeySubmit = async () => {
    if (!linearApiKey.trim()) return
    setLinearLoading(true)
    setLinearError(null)
    try {
      const { fetchTeams } = await import('../utils/linear-client')
      const teams = await fetchTeams(linearApiKey.trim())
      setLinearTeams(teams)
      if (teams.length === 1) setLinearSelectedTeam(teams[0].id)
    } catch (err: any) {
      setLinearError(err?.message === 'LINEAR_UNAUTHORIZED' ? 'Invalid API key' : 'Failed to connect')
    } finally {
      setLinearLoading(false)
    }
  }

  const handleLinearSave = async () => {
    const team = linearTeams.find((t) => t.id === linearSelectedTeam)
    if (!team || !linearApiKey.trim()) return
    const encrypted = await window.electronAPI.linearEncryptKey(linearApiKey.trim())
    onSaveLinearConfig({ apiKey: encrypted, teamId: team.id, teamName: team.name })
    setLinearConnected(true)
    setLinearApiKey('')
    setLinearTeams([])
  }

  const handleLinearDisconnect = () => {
    onSaveLinearConfig(undefined)
    setLinearConnected(false)
    setLinearApiKey('')
    setLinearTeams([])
    setLinearSelectedTeam('')
  }

  const handleDiscoverSuperset = async () => {
    if (!workspaceRootDir) return
    setImportLoading(true)
    try {
      const [supersetResults, gitResults] = await Promise.all([
        window.electronAPI.getSupersetWorktrees(workspaceRootDir),
        window.electronAPI.scanWorktreesDir(workspaceRootDir, worktreesDir),
      ])
      // Merge both sources, dedup by path
      const seen = new Set<string>()
      const merged: typeof supersetResults = []
      for (const wt of [...gitResults, ...supersetResults]) {
        if (!seen.has(wt.path)) {
          seen.add(wt.path)
          merged.push(wt)
        }
      }
      const filtered = merged.filter(w => !existingTreePaths.includes(w.path))
      setSupersetWorktrees(filtered)
      setSelectedImports(new Set(filtered.map(w => w.path)))
    } finally {
      setImportLoading(false)
    }
  }

  const handleImportSelected = () => {
    const paths = Array.from(selectedImports)
    if (paths.length > 0) {
      onImportWorktrees(paths)
      setImportDone(true)
    }
  }

  const toggleImportSelection = (path: string) => {
    setSelectedImports(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-xl w-[480px] shadow-2xl max-h-[80vh] flex flex-col"
        style={{ backgroundColor: color, border: `1px solid ${borderClr}` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- Index page ---- */}
        {page === 'index' && (
          <>
            <div className="px-6 pt-5 pb-1">
              <h2 className="text-lg font-semibold" style={{ color: txt }}>Settings</h2>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
              <SettingsMenuItem
                title="Appearance"
                description={`${emoji || '📁'} ${color}`}
                onClick={() => setPage('appearance')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Notifications"
                description="Completion and input sounds"
                onClick={() => setPage('notifications')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Interruption Mode"
                description={interruptionEnabled ? 'Enabled' : 'Disabled'}
                onClick={() => setPage('interruption')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Actions"
                description={`${customActions.length} custom command${customActions.length !== 1 ? 's' : ''}`}
                onClick={() => setPage('actions')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Repository"
                description={repoSettingsEnabled ? 'Shared settings enabled' : 'Local settings only'}
                onClick={() => setPage('repository')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Worktrees"
                description={worktreesDir || '~/.orchestra/worktrees'}
                onClick={() => setPage('worktrees')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
              <SettingsMenuItem
                title="Linear"
                description={linearConnected ? `Connected to ${linearConfig?.teamName ?? 'team'}` : 'Not connected'}
                onClick={() => setPage('linear')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
            </div>
            <div className="px-6 pb-5 pt-2 flex justify-end gap-2">
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
          </>
        )}

        {/* ---- Appearance page ---- */}
        {page === 'appearance' && (
          <>
            <PageHeader title="Appearance" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
              <div>
                <label className="block text-sm mb-3" style={{ color: mutedTxt }}>Workspace emoji</label>
                <EmojiPicker
                  value={emoji}
                  onChange={setEmoji}
                  bg={inputBg}
                  txt={txt}
                  mutedTxt={mutedTxt}
                />
              </div>
              <div>
                <label className="block text-sm mb-3" style={{ color: mutedTxt }}>Workspace color</label>
                <div className="flex flex-col items-center gap-3">
                  <ColorPicker color={color} onChange={setColor} />
                  <span className="text-xs font-mono" style={{ color: mutedTxt }}>{color}</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ---- Notifications page ---- */}
        {page === 'notifications' && (
          <>
            <PageHeader title="Notifications" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
              <SoundControl
                label="Completion sound"
                path={soundPath}
                displayName={soundPath ? soundPath.split('/').pop()! : 'Default'}
                onPathChange={setSoundPath}
                onPreview={() => { void previewSound(soundPath) }}
                txt={txt}
                mutedTxt={mutedTxt}
                inputBg={inputBg}
                inputBorder={inputBorder}
              />
              <SoundControl
                label="User-input sound"
                path={questionSoundPath}
                displayName={
                  questionSoundPath
                    ? questionSoundPath.split('/').pop()!
                    : soundPath
                      ? `${soundPath.split('/').pop()} (completion sound)`
                      : 'Default'
                }
                resetLabel="Reset to completion sound"
                onPathChange={setQuestionSoundPath}
                onPreview={() => { void previewSound(questionSoundPath ?? soundPath) }}
                txt={txt}
                mutedTxt={mutedTxt}
                inputBg={inputBg}
                inputBorder={inputBorder}
              />
            </div>
          </>
        )}

        {/* ---- Interruption Mode page ---- */}
        {page === 'interruption' && (
          <>
            <PageHeader title="Interruption Mode" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
              <Toggle
                label="Enable interruption popups"
                value={interruptionEnabled}
                onChange={(v) => {
                  setInterruptionEnabled(v)
                  onUpdateInterruptionMode(v)
                }}
                txt={txt}
                mutedTxt={mutedTxt}
              />
              <p className="text-xs px-2" style={{ color: mutedTxt }}>
                When enabled, a floating terminal popup appears whenever an agent needs your input — even if Orchestra is not focused.
              </p>

              {interruptionEnabled && (
                <div className="space-y-3 pt-2">
                  <label className="text-xs font-medium px-2" style={{ color: txt }}>
                    Popup position
                  </label>
                  <div className="flex gap-2 px-2">
                    {(['bottom-left', 'bottom-right', 'custom'] as const).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => {
                          setInterruptionPos(opt)
                          if (opt !== 'custom') {
                            onUpdateInterruptionPosition(opt)
                          }
                        }}
                        className="text-xs px-3 py-1.5 rounded transition-colors"
                        style={{
                          backgroundColor: interruptionPos === opt ? txt + '22' : 'transparent',
                          color: interruptionPos === opt ? txt : mutedTxt,
                          border: `1px solid ${interruptionPos === opt ? txt + '33' : 'transparent'}`,
                        }}
                      >
                        {opt === 'bottom-left' ? 'Bottom Left' : opt === 'bottom-right' ? 'Bottom Right' : 'Custom'}
                      </button>
                    ))}
                  </div>

                  {interruptionPos === 'custom' && (
                    <div className="flex gap-3 px-2 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: mutedTxt }}>X</span>
                        <input
                          type="number"
                          value={customX}
                          onChange={(e) => {
                            const x = parseInt(e.target.value, 10) || 0
                            setCustomX(x)
                            onUpdateInterruptionPosition({ x, y: customY })
                          }}
                          className="w-20 text-xs px-2 py-1 rounded outline-none"
                          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: mutedTxt }}>Y</span>
                        <input
                          type="number"
                          value={customY}
                          onChange={(e) => {
                            const y = parseInt(e.target.value, 10) || 0
                            setCustomY(y)
                            onUpdateInterruptionPosition({ x: customX, y })
                          }}
                          className="w-20 text-xs px-2 py-1 rounded outline-none"
                          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ---- Actions page ---- */}
        {page === 'actions' && (
          <>
            <PageHeader title="Actions" onBack={() => setPage('index')} txt={txt}>
              <button
                onClick={() => setShowAddAction(true)}
                className="text-xs hover:opacity-80 transition-opacity"
                style={{ color: mutedTxt }}
              >
                + Add
              </button>
            </PageHeader>
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-1">
              {customActions.length === 0 && (
                <div className="text-center py-12 text-sm" style={{ color: mutedTxt }}>
                  No custom actions yet
                </div>
              )}
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
                  onEditFull={() => setEditingAction(action)}
                  onUpdate={(updates) => onUpdateAction(action.id, updates)}
                  onDelete={() => onDeleteAction(action.id)}
                />
              ))}
            </div>
          </>
        )}

        {/* ---- Repository page ---- */}
        {page === 'repository' && (
          <>
            <PageHeader title="Repository" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              <Toggle
                label="Save workspace settings in this repository"
                value={repoSettingsEnabled}
                onChange={setRepoSettingsEnabled}
                txt={txt}
                mutedTxt={mutedTxt}
                bg={inputBg}
              />
              <p className="mt-3 text-xs leading-5" style={{ color: mutedTxt }}>
                Shares workspace color and actions via{' '}
                <span className="font-mono">.orchestra/workspace-settings.json</span>.
                Notification sounds and the worktrees directory stay local to each machine.
              </p>
            </div>
          </>
        )}

        {/* ---- Worktrees page ---- */}
        {page === 'worktrees' && (
          <>
            <PageHeader title="Worktrees" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              <label className="block text-sm mb-1.5" style={{ color: mutedTxt }}>Default directory</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={worktreesDir}
                  onChange={(e) => setWorktreesDir(e.target.value)}
                  placeholder="~/.orchestra/worktrees"
                  className="flex-1 rounded-md px-3 py-2 text-sm focus:outline-none"
                  style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
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
              <p className="mt-3 text-xs leading-5" style={{ color: mutedTxt }}>
                Where git worktrees are created. Leave empty for the default location.
              </p>

              {/* Import from Superset */}
              <div className="mt-6 pt-4" style={{ borderTop: `1px solid ${borderClr}` }}>
                <label className="block text-sm mb-2" style={{ color: mutedTxt }}>Import from Superset</label>

                {!importDone && supersetWorktrees.length === 0 && (
                  <>
                    <button
                      onClick={handleDiscoverSuperset}
                      disabled={importLoading || !workspaceRootDir}
                      className="px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
                      style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                    >
                      {importLoading ? 'Searching...' : 'Find Superset worktrees'}
                    </button>
                    {!importLoading && (
                      <p className="mt-2 text-xs" style={{ color: mutedTxt }}>
                        Discover worktrees created in Superset for this repository.
                      </p>
                    )}
                  </>
                )}

                {!importDone && supersetWorktrees.length > 0 && (
                  <div className="space-y-2">
                    {supersetWorktrees.map((wt) => (
                      <label
                        key={wt.path}
                        className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
                        style={{ backgroundColor: inputBg }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedImports.has(wt.path)}
                          onChange={() => toggleImportSelection(wt.path)}
                          className="accent-current"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate" style={{ color: txt }}>{wt.branch}</div>
                          <div className="text-xs truncate font-mono" style={{ color: mutedTxt }}>{wt.path}</div>
                        </div>
                      </label>
                    ))}
                    <button
                      onClick={handleImportSelected}
                      disabled={selectedImports.size === 0}
                      className="mt-2 px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
                      style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                    >
                      Import {selectedImports.size} worktree{selectedImports.size !== 1 ? 's' : ''}
                    </button>
                  </div>
                )}

                {importDone && (
                  <p className="text-sm" style={{ color: txt }}>
                    Worktrees imported successfully.
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {/* ---- Linear page ---- */}
        {page === 'linear' && (
          <>
            <PageHeader title="Linear" onBack={() => setPage('index')} txt={txt} />
            <div className="px-6 pb-5 space-y-4">
              {linearConnected ? (
                <div className="space-y-3">
                  <div className="text-sm opacity-70" style={{ color: txt }}>
                    Connected to team: <strong>{linearConfig?.teamName}</strong>
                  </div>
                  <button
                    onClick={handleLinearDisconnect}
                    className="text-xs px-3 py-1.5 rounded-md transition-colors"
                    style={{ color: txt, border: `1px solid ${borderClr}`, backgroundColor: subtleBg }}
                  >
                    Disconnect Linear
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: mutedTxt }}>API Key</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={linearApiKey}
                        onChange={(e) => setLinearApiKey(e.target.value)}
                        placeholder="lin_api_..."
                        className="flex-1 rounded-md px-3 py-2 text-sm focus:outline-none"
                        style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleLinearKeySubmit() }}
                      />
                      <button
                        onClick={handleLinearKeySubmit}
                        disabled={!linearApiKey.trim() || linearLoading}
                        className="text-xs px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                        style={{ color: txt, backgroundColor: subtleBg }}
                      >
                        {linearLoading ? 'Loading...' : 'Connect'}
                      </button>
                    </div>
                    {linearError && <p className="text-xs mt-1" style={{ color: '#f76a6a' }}>{linearError}</p>}
                  </div>

                  {linearTeams.length > 0 && (
                    <div>
                      <label className="text-xs block mb-1" style={{ color: mutedTxt }}>Team</label>
                      <select
                        value={linearSelectedTeam}
                        onChange={(e) => setLinearSelectedTeam(e.target.value)}
                        className="w-full rounded-md px-3 py-2 text-sm"
                        style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
                      >
                        <option value="">Select a team</option>
                        {linearTeams.map((t) => (
                          <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
                        ))}
                      </select>
                      <button
                        onClick={handleLinearSave}
                        disabled={!linearSelectedTeam}
                        className="mt-3 text-xs px-4 py-2 rounded-md transition-colors disabled:opacity-50"
                        style={{ color: txt, backgroundColor: subtleBg }}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showAddAction && (
        <AddActionDialog
          wsColor={color}
          workspaceId={workspaceId}
          worktrees={worktrees}
          onSave={(action) => { onAddAction(action); setShowAddAction(false) }}
          onCancel={() => setShowAddAction(false)}
        />
      )}
      {editingAction && (
        <AddActionDialog
          wsColor={color}
          workspaceId={workspaceId}
          worktrees={worktrees}
          existingAction={editingAction}
          onSave={(action) => {
            onUpdateAction(action.id, action)
            setEditingAction(null)
          }}
          onUpdate={onUpdateAction}
          onCancel={() => setEditingAction(null)}
        />
      )}
    </div>
  )
}

/* ---- Shared sub-components ---- */

function PageHeader({ title, onBack, txt, children }: {
  title: string
  onBack: () => void
  txt: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-6 py-4">
      <button onClick={onBack} className="hover:opacity-80 transition-opacity" title="Back">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 4l-4 4 4 4" stroke={txt} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      <h2 className="text-lg font-semibold flex-1" style={{ color: txt }}>{title}</h2>
      {children}
    </div>
  )
}

function SettingsMenuItem({ title, description, onClick, txt, mutedTxt, light }: {
  title: string
  description: string
  onClick: () => void
  txt: string
  mutedTxt: string
  light: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg transition-colors ${light ? 'hover:bg-black/5' : 'hover:bg-white/5'}`}
    >
      <div className="flex-1 text-left min-w-0">
        <div className="text-sm font-medium" style={{ color: txt }}>{title}</div>
        <div className="text-xs mt-0.5 truncate font-mono" style={{ color: mutedTxt }}>{description}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
        <path d="M6 4l4 4-4 4" stroke={mutedTxt} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

function SoundControl({ label, path, displayName, resetLabel, onPathChange, onPreview, txt, mutedTxt, inputBg, inputBorder }: {
  label: string
  path: string | undefined
  displayName: string
  resetLabel?: string
  onPathChange: (path: string | undefined) => void
  onPreview: () => void
  txt: string
  mutedTxt: string
  inputBg: string
  inputBorder: string
}) {
  return (
    <div>
      <label className="block text-sm mb-1.5" style={{ color: mutedTxt }}>{label}</label>
      <div className="flex items-center gap-2">
        <div
          className="flex-1 rounded-md px-3 py-2 text-sm truncate"
          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
          title={path ?? 'Default'}
        >
          {displayName}
        </div>
        <button
          onClick={onPreview}
          className="px-2 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: mutedTxt }}
          title="Preview sound"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3 5.5v5l3.5 3V2.5L3 5.5zm4.5-4v13l-4-3.5H1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.5l4-3.5zM12.5 8a3.5 3.5 0 0 0-1.75-3.03v6.06A3.5 3.5 0 0 0 12.5 8zm-1.75-5.91v1.5A5 5 0 0 1 13 8a5 5 0 0 1-2.25 4.41v1.5A6.5 6.5 0 0 0 14.5 8a6.5 6.5 0 0 0-3.75-5.91z" />
          </svg>
        </button>
        <button
          onClick={async () => {
            const file = await window.electronAPI.selectFile([{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }])
            if (file) onPathChange(file)
          }}
          className="px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: mutedTxt }}
        >
          Browse
        </button>
        {path && (
          <button
            onClick={() => onPathChange(undefined)}
            className="px-2 py-2 text-xs rounded-md hover:opacity-80 transition-opacity"
            style={{ color: mutedTxt }}
            title={resetLabel ?? 'Reset to default'}
          >
            Reset
          </button>
        )}
      </div>
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
  placeholderClr: _placeholderClr,
  onEdit,
  onEditFull,
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
  onEditFull: () => void
  onUpdate: (updates: Partial<CustomAction>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(action.name)
  const [icon, setIcon] = useState(action.icon)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [command, setCommand] = useState(action.command)
  const [keybinding, setKeybinding] = useState(action.keybinding)
  const [runOnWorktreeCreation, setRunOnWorktreeCreation] = useState(action.runOnWorktreeCreation ?? false)
  const [runOnWorktreeDestruction, setRunOnWorktreeDestruction] = useState(action.runOnWorktreeDestruction ?? false)
  const [singleSession, setSingleSession] = useState(action.singleSession ?? false)
  const [focusOnCreation, setFocusOnCreation] = useState(action.focusOnCreation !== false)
  const [runInBackground, setRunInBackground] = useState(action.runInBackground ?? false)
  const [actionType, setActionType] = useState<import('../../../shared/types').ActionType>(action.actionType ?? 'cli')
  const [printMode, setPrintMode] = useState(action.printMode ?? false)

  const handleKeybindingKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Escape') return // let window handler close dialog
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
    onUpdate({ name, icon, command, keybinding, runOnWorktreeCreation, runOnWorktreeDestruction, singleSession, focusOnCreation, runInBackground, actionType, printMode: (actionType === 'claude' || actionType === 'codex') ? printMode : undefined })
    onEdit()
  }

  return (
    <div className="rounded-md" style={{ backgroundColor: subtleBg, border: `1px solid ${borderClr}` }}>
      {/* Collapsed row */}
      <div className="flex items-center gap-2.5 px-3 py-2 cursor-pointer" onClick={onEdit}>
        <DynamicIcon name={action.icon} size={16} color={mutedTxt} />
        <span className="text-sm flex-1 truncate" style={{ color: txt }}>{action.name}</span>
        {action.schedule && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${txt}15`, color: mutedTxt }}>
            {action.schedule.mode}
          </span>
        )}
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
            <div className="flex gap-2">
              <button
                onClick={() => setShowIconPicker(true)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded border transition-colors hover:opacity-80"
                style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
                title="Choose icon"
              >
                <DynamicIcon name={icon} size={16} color={txt} />
              </button>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 rounded px-2 py-1.5 text-sm focus:outline-none"
                style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
              />
            </div>
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
          {(actionType === 'claude' || actionType === 'codex') && (
            <div className="flex items-center justify-between py-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: mutedTxt }}>Mode</span>
                <span
                  className="inline-flex items-center justify-center cursor-help"
                  title={'Interactive: The agent stays running in the terminal. You can interact with it.\n\nPrint: The agent processes the prompt, prints output, and exits.'}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: txt, opacity: 0.35 }}>
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2" />
                    <text x="8" y="11.5" textAnchor="middle" fill="currentColor" fontSize="9" fontWeight="600" fontFamily="system-ui">i</text>
                  </svg>
                </span>
              </div>
              <div className="flex gap-0.5 rounded p-0.5" style={{ backgroundColor: inputBg }}>
                <button
                  type="button"
                  onClick={() => setPrintMode(false)}
                  className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: !printMode ? `${txt}20` : 'transparent',
                    color: !printMode ? txt : mutedTxt,
                  }}
                >
                  Interactive
                </button>
                <button
                  type="button"
                  onClick={() => setPrintMode(true)}
                  className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: printMode ? `${txt}20` : 'transparent',
                    color: printMode ? txt : mutedTxt,
                  }}
                >
                  Print
                </button>
              </div>
            </div>
          )}
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
          {!action.isDefault && (
            <button
              onClick={(e) => { e.stopPropagation(); onEditFull() }}
              className="w-full text-xs py-1.5 rounded transition-colors hover:opacity-80"
              style={{ backgroundColor: inputBg, color: mutedTxt }}
            >
              {action.schedule ? 'Edit Schedule' : 'Add Schedule'}
            </button>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onEdit} className="text-xs hover:opacity-80" style={{ color: mutedTxt }}>Cancel</button>
            <button onClick={handleSave} className="text-xs hover:opacity-80" style={{ color: txt }}>Save</button>
          </div>
        </div>
      )}
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
