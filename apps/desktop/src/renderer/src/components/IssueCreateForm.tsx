import { useState, useRef, useEffect } from 'react'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

interface IssueCreateFormProps {
  defaultStatus: IssueStatus
  txtColor: string
  isLight: boolean
  onSubmit: (title: string, status: IssueStatus) => void
  onCancel: () => void
}

export function IssueCreateForm({ defaultStatus, txtColor, isLight, onSubmit, onCancel }: IssueCreateFormProps) {
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    onSubmit(trimmed, defaultStatus)
    setTitle('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const bg = isLight ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)'

  return (
    <div className="rounded-lg px-3 py-2.5" style={{ backgroundColor: bg }}>
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!title.trim()) onCancel() }}
        placeholder="Issue title..."
        className="w-full text-sm bg-transparent outline-none placeholder:opacity-40"
        style={{ color: txtColor }}
      />
    </div>
  )
}
