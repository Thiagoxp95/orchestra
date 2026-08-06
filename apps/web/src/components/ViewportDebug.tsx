'use client'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * TEMPORARY diagnostic overlay for the iOS keyboard-jump bug. Shows the raw
 * numbers the shell sizing decision is made from, live, as the keyboard opens.
 *
 * Portaled to <body> and position:fixed on purpose — it must NOT sit inside the
 * shell whose position we're trying to measure, or it would move with it and
 * tell us nothing.
 *
 * Delete this file (and its use in page.tsx) once the bug is pinned down.
 */
export function ViewportDebug() {
  const [lines, setLines] = useState<string[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const read = (): void => {
      const root = document.documentElement
      const vv = window.visualViewport
      const cs = getComputedStyle(root)
      // Where the shell actually ended up on screen — the number that tells us
      // whether it jumped, independent of what we *asked* for.
      const inset = document.querySelector('[data-slot="sidebar-inset"]')
      const rect = inset?.getBoundingClientRect()
      setLines([
        `kbd=${root.dataset.keyboard ?? '?'}`,
        `innerH=${window.innerHeight}`,
        `vv.h=${vv ? Math.round(vv.height) : '-'}  vv.top=${vv ? Math.round(vv.offsetTop) : '-'}  scale=${vv ? vv.scale.toFixed(2) : '-'}`,
        `--app-h=${cs.getPropertyValue('--app-h').trim() || '-'}`,
        `--app-top=${cs.getPropertyValue('--app-top').trim() || '-'}`,
        `--app-tallest=${cs.getPropertyValue('--app-tallest').trim() || '-'}`,
        `shell.top=${rect ? Math.round(rect.top) : '-'}  shell.h=${rect ? Math.round(rect.height) : '-'}`,
        `scrollY=${Math.round(window.scrollY)}  bodyTop=${Math.round(document.body.getBoundingClientRect().top)}`,
      ])
    }
    read()
    const vv = window.visualViewport
    vv?.addEventListener('resize', read)
    vv?.addEventListener('scroll', read)
    window.addEventListener('resize', read)
    window.addEventListener('scroll', read)
    // Layout settles a frame or two after the keyboard animation; poll slowly so
    // a late reflow can't leave a stale reading on screen for the screenshot.
    const timer = setInterval(read, 250)
    return () => {
      vv?.removeEventListener('resize', read)
      vv?.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      window.removeEventListener('scroll', read)
      clearInterval(timer)
    }
  }, [])

  if (!mounted) return null

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 2147483647,
        background: 'rgba(0,0,0,0.85)',
        color: '#0f0',
        font: '10px/1.35 ui-monospace, monospace',
        padding: '4px 6px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {lines.join('\n')}
    </div>,
    document.body,
  )
}
