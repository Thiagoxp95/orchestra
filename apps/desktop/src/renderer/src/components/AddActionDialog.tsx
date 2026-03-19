import { useState, useRef, useEffect } from 'react'
import { IconPicker } from './IconPicker'
import { DynamicIcon } from './DynamicIcon'
import { Toggle } from './Toggle'
import { textColor, isLightColor } from '../utils/color'
import type { CustomAction, ActionType } from '../../../shared/types'
import { validateSchedule } from '../../../shared/schedule-utils'
import { CODEX_INTERACTIVE_COMMAND_PREVIEW, CODEX_PRINT_COMMAND_PREVIEW } from '../../../shared/action-utils'

interface AddActionDialogProps {
  wsColor: string
  workspaceId: string
  existingAction?: CustomAction
  worktrees?: { rootDir: string; label: string }[]
  onSave: (action: CustomAction) => void
  onUpdate?: (id: string, updates: Partial<CustomAction>) => void
  onCancel: () => void
}

function DayPicker({ days, onChange, txt, inputBg, wsColor }: {
  days: number[]; onChange: (days: number[]) => void; txt: string; inputBg: string; wsColor: string
}) {
  const labels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
  return (
    <div>
      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Days</label>
      <div className="flex gap-1.5">
        {labels.map((label, i) => {
          const day = i + 1
          const active = days.includes(day)
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active) onChange(days.filter((d) => d !== day))
                else onChange([...days, day].sort())
              }}
              className="w-8 h-8 rounded-full text-[10px] font-semibold transition-colors"
              style={{
                backgroundColor: active ? txt : inputBg,
                color: active ? wsColor : txt,
                opacity: active ? 1 : 0.5,
              }}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AddActionDialog({ wsColor, workspaceId, existingAction, worktrees = [], onSave, onUpdate, onCancel }: AddActionDialogProps) {
  const [name, setName] = useState(existingAction?.name ?? '')
  const [icon, setIcon] = useState(existingAction?.icon ?? 'PlayIcon')
  const [command, setCommand] = useState(existingAction?.command ?? '')
  const [keybinding, setKeybinding] = useState(existingAction?.keybinding ?? '')
  const [runOnWorktree, setRunOnWorktree] = useState(existingAction?.runOnWorktreeCreation ?? false)
  const [runOnWorktreeDestruction, setRunOnWorktreeDestruction] = useState(existingAction?.runOnWorktreeDestruction ?? false)
  const [singleSession, setSingleSession] = useState(existingAction?.singleSession ?? false)
  const [focusOnCreation, setFocusOnCreation] = useState(existingAction?.focusOnCreation ?? true)
  const [runInBackground, setRunInBackground] = useState(existingAction?.runInBackground ?? false)
  const [actionType, setActionType] = useState<ActionType>(existingAction?.actionType ?? 'cli')
  const [printMode, setPrintMode] = useState(existingAction?.printMode ?? false)
  const [showIconPicker, setShowIconPicker] = useState(false)

  // Schedule state
  const [showSchedule, setShowSchedule] = useState(!!existingAction?.schedule)
  const [scheduleMode, setScheduleMode] = useState<'daily' | 'interval' | 'cron'>(
    existingAction?.schedule?.mode ?? 'interval'
  )
  const [dailyTime, setDailyTime] = useState(
    existingAction?.schedule?.mode === 'daily' ? existingAction.schedule.time : '09:00'
  )
  const [intervalMinutes, setIntervalMinutes] = useState(
    existingAction?.schedule?.mode === 'interval' ? existingAction.schedule.intervalMinutes : 60
  )
  const [cronExpression, setCronExpression] = useState(
    existingAction?.schedule?.mode === 'cron' ? existingAction.schedule.cronExpression : '0 9 * * *'
  )
  const [scheduleDays, setScheduleDays] = useState<number[]>(
    (existingAction?.schedule?.mode === 'daily' || existingAction?.schedule?.mode === 'interval')
      ? existingAction.schedule.days
      : [1, 2, 3, 4, 5, 6, 7]
  )
  const [automationEnabled, setAutomationEnabled] = useState(existingAction?.automationEnabled ?? true)
  const [persistWhenClosed, setPersistWhenClosed] = useState(existingAction?.persistWhenClosed ?? false)
  const [targetTreeIndex, setTargetTreeIndex] = useState(existingAction?.automationTargetTreeIndex ?? 0)
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  // Webhook state
  const [webhookToken, setWebhookToken] = useState(existingAction?.webhookToken ?? '')
  const [webhookUrl, setWebhookUrl] = useState(existingAction?.webhookUrl ?? '')
  const [webhookFilter, setWebhookFilter] = useState(existingAction?.webhookFilter ?? '')
  const [webhookFilterEnabled, setWebhookFilterEnabled] = useState(!!existingAction?.webhookFilter)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState(false)
  const [filterSaving, setFilterSaving] = useState(false)

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

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleKeybindingKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Escape') return // let window handler close dialog
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

  const handleEnableWebhook = async () => {
    if (!existingAction) return
    setWebhookLoading(true)
    try {
      const filterValue = webhookFilterEnabled ? webhookFilter.trim() : undefined
      const result = await window.electronAPI.webhookEnable(
        workspaceId,
        existingAction.id,
        name.trim() || existingAction.name,
        filterValue,
      )
      setWebhookToken(result.token)
      setWebhookUrl(result.url)
      // Persist immediately — don't wait for Save
      onUpdate?.(existingAction.id, {
        webhookToken: result.token,
        webhookUrl: result.url,
        webhookFilter: filterValue,
      })
    } catch (error) {
      console.error('Failed to enable webhook:', error)
    } finally {
      setWebhookLoading(false)
    }
  }

  const handleDisableWebhook = async () => {
    if (!existingAction || !webhookToken) return
    setWebhookLoading(true)
    try {
      await window.electronAPI.webhookDisable(workspaceId, existingAction.id, webhookToken)
      setWebhookToken('')
      setWebhookUrl('')
      setWebhookFilter('')
      setWebhookFilterEnabled(false)
      // Persist immediately
      onUpdate?.(existingAction.id, { webhookToken: undefined, webhookUrl: undefined, webhookFilter: undefined })
    } catch (error) {
      console.error('Failed to disable webhook:', error)
    } finally {
      setWebhookLoading(false)
    }
  }

  const handleToggleFilter = async (enabled: boolean) => {
    setWebhookFilterEnabled(enabled)
    if (!enabled && webhookToken) {
      // Turn off filter — update backend immediately
      setFilterSaving(true)
      try {
        await window.electronAPI.webhookUpdateFilter(webhookToken, undefined)
        onUpdate?.(existingAction!.id, { webhookFilter: undefined })
      } catch (error) {
        console.error('Failed to clear webhook filter:', error)
      } finally {
        setFilterSaving(false)
      }
    }
  }

  const handleSaveFilter = async () => {
    if (!webhookToken || !webhookFilter.trim()) return
    setFilterSaving(true)
    try {
      const filterValue = webhookFilter.trim()
      await window.electronAPI.webhookUpdateFilter(webhookToken, filterValue)
      onUpdate?.(existingAction!.id, { webhookFilter: filterValue })
    } catch (error) {
      console.error('Failed to save webhook filter:', error)
    } finally {
      setFilterSaving(false)
    }
  }

  const handleCopyWebhookUrl = () => {
    if (!webhookUrl) return
    navigator.clipboard.writeText(webhookUrl)
    setWebhookCopied(true)
    setTimeout(() => setWebhookCopied(false), 2000)
  }

  const handleSave = () => {
    if (!name.trim() || !command.trim()) return

    let schedule: CustomAction['schedule'] = undefined
    if (showSchedule) {
      if (scheduleMode === 'daily') {
        schedule = { mode: 'daily', time: dailyTime, days: scheduleDays }
      } else if (scheduleMode === 'interval') {
        schedule = { mode: 'interval', intervalMinutes, days: scheduleDays }
      } else if (scheduleMode === 'cron') {
        schedule = { mode: 'cron', cronExpression }
      }
      if (schedule) {
        const error = validateSchedule(schedule)
        if (error) { setScheduleError(error); return }
      }
    }
    setScheduleError(null)

    onSave({
      id: existingAction?.id ?? crypto.randomUUID(),
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
      printMode: (actionType === 'claude' || actionType === 'codex') ? printMode : undefined,
      schedule,
      automationEnabled: showSchedule ? automationEnabled : undefined,
      persistWhenClosed: showSchedule ? (scheduleMode === 'cron' ? false : persistWhenClosed) : undefined,
      automationTargetTreeIndex: showSchedule ? targetTreeIndex : undefined,
      webhookToken: webhookToken || undefined,
      webhookUrl: webhookUrl || undefined,
      webhookFilter: (webhookFilterEnabled && webhookFilter.trim()) ? webhookFilter.trim() : undefined,
    })
  }

  const inputStyle: React.CSSProperties = {
    backgroundColor: inputBg,
    borderColor: inputBorder,
    color: txt,
  }

  const inputClass = 'w-full rounded-md px-3 py-2 text-sm border focus:outline-none transition-colors'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="rounded-xl w-[420px] max-h-[85vh] flex flex-col shadow-2xl border" style={{ backgroundColor: wsColor, borderColor: borderClr }} onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-6 pt-6 pb-0">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold" style={{ color: txt }}>{existingAction ? 'Edit Action' : 'Add Action'}</h2>
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
        </div>

        <div className="overflow-y-auto px-6 pb-2 space-y-4">
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
                Runs as <code className="px-1 py-0.5 rounded" style={{ backgroundColor: inputBg, color: txt }}>{printMode ? `${CODEX_PRINT_COMMAND_PREVIEW} [prompt]` : `${CODEX_INTERACTIVE_COMMAND_PREVIEW} [prompt]`}</code>. {printMode ? 'Prints the output and exits.' : 'The session stays attached to the terminal.'}
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

          {/* Webhook section */}
          <div className="border-t pt-4 mt-2" style={{ borderColor: borderClr }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium" style={{ color: txt }}>Webhook</span>
              {existingAction ? (
                webhookToken ? (
                  <button
                    type="button"
                    onClick={handleDisableWebhook}
                    disabled={webhookLoading}
                    className="text-xs px-2 py-1 rounded transition-colors opacity-60 hover:opacity-100"
                    style={{ color: txt }}
                  >
                    {webhookLoading ? 'Removing...' : 'Remove'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleEnableWebhook}
                    disabled={webhookLoading}
                    className="text-xs px-2.5 py-1 rounded transition-colors"
                    style={{ backgroundColor: `${txt}1a`, color: txt, opacity: webhookLoading ? 0.5 : 1 }}
                  >
                    {webhookLoading ? 'Enabling...' : 'Enable'}
                  </button>
                )
              ) : null}
            </div>

            {!existingAction ? (
              <p className="text-[10px] opacity-50" style={{ color: txt }}>
                Save the action first, then edit it to enable a webhook URL.
              </p>
            ) : webhookUrl ? (
              <div className="space-y-3">
                <div>
                  <div
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-mono cursor-pointer transition-colors"
                    style={{ backgroundColor: inputBg, color: txt, opacity: 0.8 }}
                    onClick={handleCopyWebhookUrl}
                    title="Click to copy"
                  >
                    <span className="truncate flex-1">{webhookUrl}</span>
                    <span className="shrink-0 text-[10px] opacity-60">
                      {webhookCopied ? 'Copied!' : 'Copy'}
                    </span>
                  </div>
                  <p className="text-[10px] mt-1.5 opacity-50" style={{ color: txt }}>
                    Give this URL to Linear, GitHub, or any service that supports webhooks.
                    When they POST to this URL, this action will run.
                  </p>
                </div>

                {/* Payload filter */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium" style={{ color: txt, opacity: 0.8 }}>
                      Payload filter
                    </span>
                    <Toggle
                      label=""
                      value={webhookFilterEnabled}
                      onChange={handleToggleFilter}
                      txt={txt}
                      mutedTxt={txt}
                      bg={toggleBg}
                    />
                  </div>
                  {webhookFilterEnabled && (
                    <div>
                      <textarea
                        value={webhookFilter}
                        onChange={(e) => setWebhookFilter(e.target.value)}
                        placeholder="e.g. Only trigger if the action is 'opened' and the label contains 'bug'"
                        rows={2}
                        className={`${inputClass} resize-y placeholder:opacity-40 text-xs`}
                        style={inputStyle}
                        onFocus={(e) => e.currentTarget.style.borderColor = inputFocusBorder}
                        onBlur={(e) => e.currentTarget.style.borderColor = inputBorder}
                      />
                      <div className="flex items-center justify-between mt-1.5">
                        <p className="text-[10px] opacity-50" style={{ color: txt }}>
                          Describe in plain English when this webhook should trigger. An LLM will evaluate each payload against this condition.
                        </p>
                        {webhookFilter.trim() && (
                          <button
                            type="button"
                            onClick={handleSaveFilter}
                            disabled={filterSaving}
                            className="shrink-0 text-[10px] px-2 py-0.5 rounded transition-colors ml-2"
                            style={{ backgroundColor: `${txt}1a`, color: txt, opacity: filterSaving ? 0.5 : 1 }}
                          >
                            {filterSaving ? 'Saving...' : 'Save filter'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[10px] opacity-50" style={{ color: txt }}>
                Enable to get a URL that external services can call to trigger this action.
              </p>
            )}
          </div>

          {/* Schedule section */}
          <div className="border-t pt-4 mt-2" style={{ borderColor: borderClr }}>
            <button
              type="button"
              onClick={() => setShowSchedule(!showSchedule)}
              className="flex items-center gap-2 text-sm font-medium w-full"
              style={{ color: txt }}
            >
              <svg
                width="12" height="12" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                style={{ transform: showSchedule ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              Schedule
            </button>

            {showSchedule && (
              <div className="mt-3 space-y-3">
                {/* Mode toggle */}
                <div className="flex gap-1 rounded-md p-1" style={{ backgroundColor: inputBg }}>
                  {(['daily', 'interval', 'cron'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setScheduleMode(mode)}
                      className="flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors capitalize"
                      style={{
                        backgroundColor: scheduleMode === mode ? `${txt}26` : 'transparent',
                        color: txt,
                        opacity: scheduleMode === mode ? 1 : 0.55,
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>

                {/* Daily: time + days */}
                {scheduleMode === 'daily' && (
                  <>
                    <div>
                      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Time</label>
                      <input
                        type="time"
                        value={dailyTime}
                        onChange={(e) => setDailyTime(e.target.value)}
                        className={`${inputClass} placeholder:opacity-40`}
                        style={inputStyle}
                      />
                    </div>
                    <DayPicker days={scheduleDays} onChange={setScheduleDays} txt={txt} inputBg={inputBg} wsColor={wsColor} />
                  </>
                )}

                {/* Interval: minutes + days */}
                {scheduleMode === 'interval' && (
                  <>
                    <div>
                      <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Run every</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          value={intervalMinutes}
                          onChange={(e) => setIntervalMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                          className={`w-20 ${inputClass}`}
                          style={inputStyle}
                        />
                        <span className="text-xs" style={{ color: txt, opacity: 0.7 }}>minutes</span>
                      </div>
                    </div>
                    <DayPicker days={scheduleDays} onChange={setScheduleDays} txt={txt} inputBg={inputBg} wsColor={wsColor} />
                  </>
                )}

                {/* Cron: expression */}
                {scheduleMode === 'cron' && (
                  <div>
                    <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Cron expression</label>
                    <input
                      type="text"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className={`${inputClass} font-mono placeholder:opacity-40`}
                      style={inputStyle}
                    />
                    <p className="text-[10px] mt-1 opacity-50" style={{ color: txt }}>
                      min hour day month weekday
                    </p>
                  </div>
                )}

                {/* Target worktree */}
                {worktrees.length > 1 && (
                  <div>
                    <label className="block text-xs mb-1 opacity-70" style={{ color: txt }}>Target</label>
                    <select
                      value={targetTreeIndex}
                      onChange={(e) => setTargetTreeIndex(parseInt(e.target.value))}
                      className={inputClass}
                      style={inputStyle}
                    >
                      {worktrees.map((wt, i) => (
                        <option key={i} value={i}>{wt.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Toggles */}
                <Toggle
                  label="Enabled"
                  value={automationEnabled}
                  onChange={setAutomationEnabled}
                  txt={txt} mutedTxt={txt} bg={toggleBg}
                />
                <Toggle
                  label="Run when app is closed"
                  value={persistWhenClosed}
                  onChange={setPersistWhenClosed}
                  txt={txt} mutedTxt={txt} bg={toggleBg}
                  disabled={scheduleMode === 'cron'}
                />
                {scheduleMode === 'cron' && persistWhenClosed && (
                  <p className="text-[10px] opacity-50" style={{ color: txt }}>
                    Cron automations cannot run when the app is closed.
                  </p>
                )}

                {scheduleError && (
                  <p className="text-[10px] text-red-400">{scheduleError}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex justify-end gap-2 px-6 py-4 border-t" style={{ borderColor: borderClr }}>
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
            {existingAction ? 'Save changes' : 'Save action'}
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
