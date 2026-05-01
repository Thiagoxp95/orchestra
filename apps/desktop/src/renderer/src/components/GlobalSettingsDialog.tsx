import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/types'
import { DEFAULT_OPENROUTER_CLASSIFIER_PROMPT, DEFAULT_OPENROUTER_MODEL } from '../../../shared/types'
import { isLightColor, textColor } from '../utils/color'
import { filterOpenRouterModels, normalizeOpenRouterModels } from '../utils/openrouter-models'

interface GlobalSettingsDialogProps {
  settings: AppSettings
  wsColor: string
  onSaveSettings: (settings: AppSettings) => void
  onClose: () => void
}

export function GlobalSettingsDialog({
  settings,
  wsColor,
  onSaveSettings,
  onClose,
}: GlobalSettingsDialogProps) {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings.openRouter?.model ?? DEFAULT_OPENROUTER_MODEL)
  const [classifierPrompt, setClassifierPrompt] = useState(
    settings.openRouter?.classifierPrompt ?? DEFAULT_OPENROUTER_CLASSIFIER_PROMPT,
  )
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')

  const light = isLightColor(wsColor)
  const txt = textColor(wsColor)
  const mutedTxt = light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)'
  const inputBg = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'
  const inputBorder = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'
  const borderClr = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'
  const subtleBg = light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'
  const pickerBg = light ? 'rgba(255,255,255,0.96)' : 'rgba(20,20,20,0.96)'
  const filteredModels = filterOpenRouterModels(models, modelQuery)

  const fetchOpenRouterModels = async (rawApiKey?: string) => {
    const api = window.electronAPI as typeof window.electronAPI & {
      openRouterListModels?: (apiKey?: string) => Promise<{ id: string; name: string }[]>
    }

    if (typeof api.openRouterListModels === 'function') {
      return api.openRouterListModels(rawApiKey)
    }

    const headers: Record<string, string> = {}
    if (rawApiKey) headers.Authorization = `Bearer ${rawApiKey}`
    const response = await fetch('https://openrouter.ai/api/v1/models', { headers })
    if (!response.ok) {
      throw new Error(`OpenRouter models request failed with HTTP ${response.status}`)
    }
    return normalizeOpenRouterModels(await response.json())
  }

  const encryptOpenRouterKey = async (rawApiKey: string) => {
    const api = window.electronAPI as typeof window.electronAPI & {
      openRouterEncryptKey?: (rawKey: string) => Promise<string>
    }

    if (typeof api.openRouterEncryptKey === 'function') {
      return api.openRouterEncryptKey(rawApiKey)
    }

    return window.electronAPI.linearEncryptKey(rawApiKey)
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    void loadModels()
  }, [])

  const loadModels = async () => {
    setLoadingModels(true)
    setModelError(null)
    try {
      const nextModels = await fetchOpenRouterModels(apiKey.trim() || undefined)
      setModels(nextModels)
    } catch (error) {
      setModelError(error instanceof Error ? error.message : 'Failed to load OpenRouter models')
    } finally {
      setLoadingModels(false)
    }
  }

  const handleSave = async () => {
    const trimmedKey = apiKey.trim()
    const encryptedApiKey = trimmedKey
      ? await encryptOpenRouterKey(trimmedKey)
      : settings.openRouter?.encryptedApiKey

    const trimmedPrompt = classifierPrompt.trim()
    onSaveSettings({
      ...settings,
      openRouter: encryptedApiKey
        ? {
            encryptedApiKey,
            model: model.trim() || DEFAULT_OPENROUTER_MODEL,
            classifierPrompt:
              trimmedPrompt && trimmedPrompt !== DEFAULT_OPENROUTER_CLASSIFIER_PROMPT
                ? trimmedPrompt
                : undefined,
          }
        : undefined,
    })
    onClose()
  }

  const handleDisconnect = () => {
    onSaveSettings({ ...settings, openRouter: undefined })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-xl w-[460px] shadow-2xl max-h-[80vh] flex flex-col"
        style={{ backgroundColor: wsColor, border: `1px solid ${borderClr}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4">
          <h2 className="text-lg font-semibold" style={{ color: txt }}>Global Settings</h2>
        </div>

        <div className="px-6 pb-5 space-y-4 overflow-y-auto">
          <div>
            <label className="text-xs block mb-1" style={{ color: mutedTxt }}>OpenRouter API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.openRouter?.encryptedApiKey ? 'Configured' : 'sk-or-v1-...'}
              className="w-full rounded-md px-3 py-2 text-sm focus:outline-none"
              style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs" style={{ color: mutedTxt }}>Model</label>
              <button
                onClick={() => { void loadModels() }}
                disabled={loadingModels}
                className="text-xs px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                style={{ color: mutedTxt, backgroundColor: subtleBg }}
              >
                {loadingModels ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setModelPickerOpen((open) => !open)
                  setModelQuery('')
                }}
                className="w-full rounded-md px-3 py-2 text-sm focus:outline-none flex items-center justify-between gap-3"
                style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
              >
                <span className="truncate text-left font-mono">{model}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0" style={{ color: mutedTxt }}>
                  <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {modelPickerOpen && (
                <div
                  className="absolute left-0 right-0 top-full mt-1 rounded-md border shadow-xl z-10 overflow-hidden"
                  style={{ backgroundColor: pickerBg, borderColor: inputBorder }}
                >
                  <div className="p-2" style={{ borderBottom: `1px solid ${inputBorder}` }}>
                    <input
                      autoFocus
                      type="text"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      placeholder={`Search ${models.length || 'OpenRouter'} models`}
                      className="w-full rounded px-2 py-1.5 text-sm focus:outline-none"
                      style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto py-1">
                    {filteredModels.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          setModel(option.id)
                          setModelPickerOpen(false)
                          setModelQuery('')
                        }}
                        className="w-full px-3 py-2 text-left hover:opacity-80 transition-opacity"
                        style={{
                          color: txt,
                          backgroundColor: option.id === model ? subtleBg : 'transparent',
                        }}
                      >
                        <div className="text-sm font-mono truncate">{option.id}</div>
                        <div className="text-xs truncate" style={{ color: mutedTxt }}>{option.name}</div>
                      </button>
                    ))}
                    {!loadingModels && filteredModels.length === 0 && (
                      <div className="px-3 py-6 text-center text-xs" style={{ color: mutedTxt }}>
                        No matching models
                      </div>
                    )}
                    {loadingModels && (
                      <div className="px-3 py-6 text-center text-xs" style={{ color: mutedTxt }}>
                        Loading models...
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {modelError && <p className="text-xs mt-1" style={{ color: '#f76a6a' }}>{modelError}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs" style={{ color: mutedTxt }}>
                Input-detection prompt
              </label>
              <button
                onClick={() => setClassifierPrompt(DEFAULT_OPENROUTER_CLASSIFIER_PROMPT)}
                disabled={classifierPrompt.trim() === DEFAULT_OPENROUTER_CLASSIFIER_PROMPT}
                className="text-xs px-2 py-1 rounded-md transition-colors disabled:opacity-40"
                style={{ color: mutedTxt, backgroundColor: subtleBg }}
              >
                Reset to default
              </button>
            </div>
            <textarea
              value={classifierPrompt}
              onChange={(e) => setClassifierPrompt(e.target.value)}
              rows={5}
              className="w-full rounded-md px-3 py-2 text-xs font-mono focus:outline-none resize-y"
              style={{ color: txt, backgroundColor: inputBg, border: `1px solid ${inputBorder}` }}
            />
            <p className="text-xs mt-1" style={{ color: mutedTxt }}>
              System prompt sent to the model that decides whether the agent is waiting for your input.
            </p>
          </div>
        </div>

        <div className="px-6 pb-5 pt-1 flex justify-between gap-2">
          <button
            onClick={handleDisconnect}
            disabled={!settings.openRouter?.encryptedApiKey && !apiKey.trim()}
            className="px-3 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
            style={{ color: mutedTxt }}
          >
            Disconnect
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity"
              style={{ color: mutedTxt }}
            >
              Cancel
            </button>
            <button
              onClick={() => { void handleSave() }}
              disabled={!apiKey.trim() && !settings.openRouter?.encryptedApiKey}
              className="px-4 py-2 text-sm rounded-md hover:opacity-80 transition-opacity disabled:opacity-40"
              style={{ backgroundColor: subtleBg, color: txt, border: `1px solid ${borderClr}` }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
