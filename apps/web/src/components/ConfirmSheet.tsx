'use client'
import { useEffect } from 'react'
import { Portal } from './Portal'

/**
 * A destructive-action confirmation, styled as the same bottom sheet the worktree
 * and workspace actions use so it reads as part of the phone UI rather than a
 * browser dialog.
 *
 * Used for every session close on the web: the sidebar's swipe-to-trash, the
 * overview card's swipe-to-trash, and the roll's leftward two-finger swipe. Those
 * are three cheap gestures on a touch screen and closing kills the PTY — the
 * conversation can be resumed later, but whatever the agent had in flight is gone.
 */
export function ConfirmSheet({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  body?: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
        onClick={onCancel}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          role="alertdialog"
          aria-modal="true"
          aria-label={title}
          className="w-full rounded-t-2xl border border-border bg-sidebar p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-sm sm:rounded-2xl"
        >
          <div className="px-1 text-base font-medium text-foreground">{title}</div>
          {body && <div className="mt-1.5 px-1 text-sm leading-snug text-muted-foreground">{body}</div>}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm text-foreground transition-colors active:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              onClick={onConfirm}
              className="flex-1 rounded-lg bg-destructive px-3 py-2.5 text-sm font-medium text-white transition-opacity active:opacity-80"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
