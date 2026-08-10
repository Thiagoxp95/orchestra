'use client'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders children into `document.body`, out of whatever stacking context the
 * caller happens to sit in.
 *
 * `z-50` only outranks `z-20` when both are in the same stacking context, and
 * the sidebar is not: `sidebar-container` is `fixed z-10`, which opens one. So a
 * sheet rendered from the sidebar tops out at the sidebar's z-10 — and the
 * sessions overview (`absolute inset-0 z-20`, inside a `relative` main that
 * creates no context of its own) paints straight over it. On a tablet, where the
 * desktop sidebar is on screen, that showed as an action sheet visible only in
 * the header strip (the one band with nothing z-indexed over it) and invisible
 * everywhere else.
 *
 * Portaling to the body puts the sheet in the root stacking context, where its
 * z-50 means what it says.
 *
 * Mounts nothing until after hydration: `document` doesn't exist during SSR, and
 * portalling on the first client render would not match the server HTML.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // Post-mount flag, the SSR-safe portal pattern; not the state-in-effect
    // anti-pattern the rule is aimed at.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])
  if (!mounted) return null
  return createPortal(children, document.body)
}
