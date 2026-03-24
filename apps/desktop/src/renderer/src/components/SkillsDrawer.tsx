import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import type { SkillEntry } from '../../../shared/types'
import { textColor } from '../utils/color'
import { DynamicIcon } from './DynamicIcon'

/** Simple fuzzy match on name — characters must appear in order */
function fuzzyMatch(query: string, name: string): { match: boolean; score: number } {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  let qi = 0
  let score = 0
  let prevMatchIdx = -1
  for (let ni = 0; ni < n.length && qi < q.length; ni++) {
    if (n[ni] === q[qi]) {
      score += (ni === prevMatchIdx + 1) ? 2 : 1
      if (ni === 0 || n[ni - 1] === '-' || n[ni - 1] === '_' || n[ni - 1] === ' ') score += 3
      prevMatchIdx = ni
      qi++
    }
  }
  return { match: qi === q.length, score }
}

const SCOPE_LABELS: Record<SkillEntry['scope'], string> = {
  project: 'Project',
  user: 'User',
}

function SourceBadge({ source }: { source: SkillEntry['source'] }) {
  const isCodex = source === 'codex-skill'
  const color = isCodex ? '#10a37f' : '#d4a574'
  return (
    <span
      className="flex items-center justify-center p-0.5 rounded shrink-0"
      style={{
        backgroundColor: `${color}18`,
        border: `1px solid ${color}30`,
      }}
    >
      <DynamicIcon
        name={isCodex ? '__openai__' : '__claude__'}
        size={12}
        color={color}
      />
    </span>
  )
}

function ScopeBadge({ scope, txtColor }: { scope: SkillEntry['scope']; txtColor: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide uppercase shrink-0"
      style={{
        color: `${txtColor}90`,
        backgroundColor: `${txtColor}08`,
        border: `1px solid ${txtColor}12`,
      }}
    >
      {SCOPE_LABELS[scope]}
    </span>
  )
}

function SkillListView({
  skills,
  wsColor,
  searchQuery,
  onSelect,
}: {
  skills: SkillEntry[]
  wsColor: string
  searchQuery: string
  onSelect: (skill: SkillEntry) => void
}) {
  const txtColor = textColor(wsColor)

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return skills
    return skills
      .map((skill) => ({ skill, ...fuzzyMatch(searchQuery, skill.name) }))
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.skill)
  }, [skills, searchQuery])

  if (skills.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-center" style={{ color: `${txtColor}60` }}>
          No skills match the current filters.
        </p>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-center" style={{ color: `${txtColor}60` }}>
          No skills matching &ldquo;{searchQuery}&rdquo;
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {filtered.map((skill) => (
        <button
          key={skill.id}
          onClick={() => onSelect(skill)}
          className="w-full text-left px-4 py-3 transition-colors hover:brightness-110 border-b"
          style={{ borderColor: `${txtColor}08` }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium truncate" style={{ color: txtColor }}>
              {skill.name}
            </span>
            <SourceBadge source={skill.source} />
            <ScopeBadge scope={skill.scope} txtColor={txtColor} />
          </div>
          {skill.description && (
            <p className="text-xs line-clamp-2 leading-relaxed" style={{ color: `${txtColor}60` }}>
              {skill.description}
            </p>
          )}
        </button>
      ))}
    </div>
  )
}

function SkillDetailView({
  skill,
  content,
  loading,
  wsColor,
  onBack,
}: {
  skill: SkillEntry
  content: string | null
  loading: boolean
  wsColor: string
  onBack: () => void
}) {
  const txtColor = textColor(wsColor)
  const [copied, setCopied] = useState(false)

  const handleCopyPath = () => {
    navigator.clipboard.writeText(skill.filePath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Header with back button */}
      <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0" style={{ borderColor: `${txtColor}15` }}>
        <button
          onClick={onBack}
          className="p-1 rounded transition-colors shrink-0"
          style={{ color: txtColor }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 12 6 8 10 4" />
          </svg>
        </button>
        <span className="text-sm font-medium truncate" style={{ color: txtColor }}>
          {skill.name}
        </span>
        <SourceBadge source={skill.source} />
        <ScopeBadge scope={skill.scope} txtColor={txtColor} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* File path + copy */}
        <button
          onClick={handleCopyPath}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono truncate max-w-[200px] transition-colors shrink-0"
          style={{
            color: `${txtColor}70`,
            backgroundColor: `${txtColor}08`,
            border: `1px solid ${txtColor}12`,
          }}
          title={skill.filePath}
        >
          <span className="truncate">{skill.filePath.split('/').slice(-2).join('/')}</span>
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={txtColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="4 8 7 11 12 5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <rect x="5" y="5" width="8" height="8" rx="1" />
              <path d="M3 11V3h8" />
            </svg>
          )}
        </button>
      </div>

      {/* Markdown content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 pb-12" style={{ color: txtColor }}>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <svg width="18" height="18" viewBox="0 0 18 18" className="animate-spin" style={{ opacity: 0.4 }} fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 2a7 7 0 0 1 7 7" />
            </svg>
          </div>
        ) : content ? (
          <div className="max-w-none
            [&_h1]:text-base [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-4
            [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mb-2 [&_h2]:mt-3
            [&_h3]:text-xs [&_h3]:font-bold [&_h3]:mb-2 [&_h3]:mt-3
            [&_p]:text-xs [&_p]:leading-relaxed [&_p]:mb-2 [&_p]:opacity-80
            [&_ul]:text-xs [&_ul]:mb-2 [&_ul]:pl-4
            [&_ol]:text-xs [&_ol]:mb-2 [&_ol]:pl-4
            [&_li]:mb-1 [&_li]:opacity-80
            [&_code]:text-[11px] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
            [&_pre]:text-[11px] [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:mb-3
            [&_pre_code]:p-0 [&_pre_code]:bg-transparent
            [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:opacity-60 [&_blockquote]:italic
            [&_table]:text-xs [&_table]:w-full
            [&_th]:text-left [&_th]:py-1 [&_th]:px-2 [&_th]:border-b
            [&_td]:py-1 [&_td]:px-2 [&_td]:border-b
            [&_hr]:my-4
            [&_a]:underline [&_a]:opacity-80
          "
            style={{
              ['--tw-prose-code-bg' as string]: `${txtColor}12`,
              ['--tw-prose-pre-bg' as string]: `${txtColor}08`,
              ['--tw-prose-border' as string]: `${txtColor}15`,
            }}
          >
            <style>{`
              .skill-md code { background: ${txtColor}12; }
              .skill-md pre { background: ${txtColor}08; }
              .skill-md th, .skill-md td { border-color: ${txtColor}15; }
              .skill-md hr { border-color: ${txtColor}15; }
              .skill-md blockquote { border-color: ${txtColor}30; }
            `}</style>
            <div className="skill-md">
              <Markdown>{content}</Markdown>
            </div>
          </div>
        ) : (
          <p className="text-xs text-center py-8" style={{ color: `${txtColor}60` }}>Failed to load skill content.</p>
        )}
      </div>
    </div>
  )
}

export function SkillsDrawer({
  wsColor,
  rootDir,
  onClose,
}: {
  wsColor: string
  rootDir: string
  onClose: () => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSkill, setSelectedSkill] = useState<SkillEntry | null>(null)
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'claude' | 'codex'>('all')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'project' | 'user'>('all')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const txtColor = textColor(wsColor)

  const filteredBySourceAndScope = useMemo(() => {
    return skills.filter((s) => {
      if (sourceFilter === 'claude' && s.source === 'codex-skill') return false
      if (sourceFilter === 'codex' && s.source !== 'codex-skill') return false
      if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false
      return true
    })
  }, [skills, sourceFilter, scopeFilter])

  const [refreshToast, setRefreshToast] = useState<string | null>(null)
  const refreshToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadSkills = useCallback(async (showToast = false) => {
    setLoading(true)
    try {
      const result = await window.electronAPI.scanSkills(rootDir)
      setSkills(result)
      if (showToast) {
        if (refreshToastTimer.current) clearTimeout(refreshToastTimer.current)
        setRefreshToast(`Found ${result.length} skill${result.length !== 1 ? 's' : ''}`)
        refreshToastTimer.current = setTimeout(() => setRefreshToast(null), 2500)
      }
    } catch {
      setSkills([])
      if (showToast) {
        if (refreshToastTimer.current) clearTimeout(refreshToastTimer.current)
        setRefreshToast('Failed to scan skills')
        refreshToastTimer.current = setTimeout(() => setRefreshToast(null), 2500)
      }
    }
    setLoading(false)
  }, [rootDir])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedSkill) {
          setSelectedSkill(null)
          setSkillContent(null)
        } else if (searchQuery) {
          setSearchQuery('')
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, selectedSkill, searchQuery])

  const handleSelectSkill = async (skill: SkillEntry) => {
    setSelectedSkill(skill)
    setContentLoading(true)
    const content = await window.electronAPI.getSkillContent(skill.filePath)
    setSkillContent(content)
    setContentLoading(false)
  }

  const handleBack = () => {
    setSelectedSkill(null)
    setSkillContent(null)
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 bottom-0 z-50 flex flex-col shadow-2xl transition-[width] duration-200 ${selectedSkill ? 'w-[600px]' : 'w-[380px]'}`}
        style={{
          backgroundColor: wsColor,
          borderLeft: `1px solid ${txtColor}15`,
          color: txtColor,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: `${txtColor}15` }}>
          <div className="flex items-center gap-2">
            {selectedSkill ? null : (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 2l8 6-8 6V2z" />
                </svg>
                <span className="text-sm font-medium" style={{ color: txtColor }}>
                  Skills
                </span>
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded-md"
                  style={{
                    color: txtColor,
                    backgroundColor: `${txtColor}10`,
                    border: `1px solid ${txtColor}18`,
                  }}
                >
                  {skills.length}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!selectedSkill && (
              <button
                onClick={() => { loadSkills(true) }}
                className="p-1.5 rounded transition-colors"
                style={{ color: txtColor }}
                title="Refresh skills"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 8a6 6 0 0 1 10.3-4.1L14 2v4h-4l1.7-1.7A4 4 0 0 0 4 8" />
                  <path d="M14 8a6 6 0 0 1-10.3 4.1L2 14v-4h4l-1.7 1.7A4 4 0 0 0 12 8" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded transition-colors"
              style={{ color: txtColor }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Refresh toast */}
        {refreshToast && (
          <div
            className="mx-3 mt-2 px-3 py-1.5 rounded-md text-xs text-center animate-toast-in"
            style={{
              color: txtColor,
              backgroundColor: `${txtColor}10`,
              border: `1px solid ${txtColor}15`,
            }}
          >
            {refreshToast}
          </div>
        )}

        {/* Search + Filters */}
        {!selectedSkill && !loading && skills.length > 0 && (
          <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1.5" style={{ borderBottom: `1px solid ${txtColor}10` }}>
            {/* Search input */}
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md"
              style={{ backgroundColor: `${txtColor}08`, border: `1px solid ${txtColor}12` }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round" className="opacity-40 shrink-0">
                <circle cx="7" cy="7" r="5" />
                <line x1="11" y1="11" x2="14" y2="14" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:opacity-30"
                style={{ color: txtColor }}
                autoFocus
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }}
                  className="opacity-40 hover:opacity-80 transition-opacity"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={txtColor} strokeWidth="2" strokeLinecap="round">
                    <line x1="4" y1="4" x2="12" y2="12" />
                    <line x1="12" y1="4" x2="4" y2="12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Filter chips */}
            <div className="flex items-center gap-1 flex-wrap">
              {/* Source filters */}
              {(['all', 'claude', 'codex'] as const).map((val) => {
                const active = sourceFilter === val
                const label = val === 'all' ? 'All' : val === 'claude' ? 'Claude' : 'Codex'
                return (
                  <button
                    key={`source-${val}`}
                    onClick={() => setSourceFilter(val)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                    style={{
                      color: active ? txtColor : `${txtColor}60`,
                      backgroundColor: active ? `${txtColor}18` : 'transparent',
                      border: `1px solid ${active ? `${txtColor}30` : `${txtColor}10`}`,
                    }}
                  >
                    {val === 'claude' && <DynamicIcon name="__claude__" size={10} color={active ? '#d4a574' : `${txtColor}60`} />}
                    {val === 'codex' && <DynamicIcon name="__openai__" size={10} color={active ? '#10a37f' : `${txtColor}60`} />}
                    {label}
                  </button>
                )
              })}

              <span className="w-px h-3 mx-0.5" style={{ backgroundColor: `${txtColor}15` }} />

              {/* Scope filters */}
              {(['all', 'project', 'user'] as const).map((val) => {
                const active = scopeFilter === val
                const label = val === 'all' ? 'All' : val === 'project' ? 'Project' : 'User'
                return (
                  <button
                    key={`scope-${val}`}
                    onClick={() => setScopeFilter(val)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                    style={{
                      color: active ? txtColor : `${txtColor}60`,
                      backgroundColor: active ? `${txtColor}18` : 'transparent',
                      border: `1px solid ${active ? `${txtColor}30` : `${txtColor}10`}`,
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 18 18" className="animate-spin" style={{ opacity: 0.4 }} fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 2a7 7 0 0 1 7 7" />
            </svg>
          </div>
        ) : selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
            content={skillContent}
            loading={contentLoading}
            wsColor={wsColor}
            onBack={handleBack}
          />
        ) : (
          <SkillListView
            skills={filteredBySourceAndScope}
            wsColor={wsColor}
            searchQuery={searchQuery}
            onSelect={handleSelectSkill}
          />
        )}
      </div>
    </>
  )
}
