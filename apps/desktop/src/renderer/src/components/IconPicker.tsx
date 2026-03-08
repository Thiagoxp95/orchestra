import { useState, useEffect, useRef, useCallback } from 'react'
import { iconNames } from '../utils/icon-names'
import { DynamicIcon } from './DynamicIcon'

interface IconPickerProps {
  value: string
  onChange: (name: string) => void
  onClose: () => void
}

const BATCH_SIZE = 60

export function IconPicker({ value, onChange, onClose }: IconPickerProps) {
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Reset visible count on search change
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
  }, [search])

  const filtered = search
    ? iconNames.filter((n) => n.toLowerCase().includes(search.toLowerCase()))
    : iconNames

  const visible = filtered.slice(0, visibleCount)

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      setVisibleCount((c) => Math.min(c + BATCH_SIZE, filtered.length))
    }
  }, [filtered.length])

  // Format icon name for display: "ComputerTerminal01Icon" → "Computer Terminal 01"
  const formatName = (name: string) =>
    name.replace(/Icon$/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2')

  return (
    <div className="fixed inset-0 z-[60]" onClick={onClose}>
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] bg-[#1e1e2e] rounded-xl shadow-2xl border border-white/10 flex flex-col"
        style={{ maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-white/10">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search icons..."
            className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20"
          />
          <p className="text-xs text-gray-500 mt-1.5">{filtered.length} icons</p>
        </div>
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-2"
          onScroll={handleScroll}
        >
          <div className="grid grid-cols-6 gap-1">
            {visible.map((name) => (
              <button
                key={name}
                onClick={() => { onChange(name); onClose() }}
                title={formatName(name)}
                className={`p-2.5 rounded-lg transition-colors flex items-center justify-center ${
                  name === value
                    ? 'bg-white/15 ring-1 ring-white/30'
                    : 'hover:bg-white/10'
                }`}
              >
                <DynamicIcon name={name} size={20} color="white" />
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-8">No icons found</p>
          )}
        </div>
      </div>
    </div>
  )
}
