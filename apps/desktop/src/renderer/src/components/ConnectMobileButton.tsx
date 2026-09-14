import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Tooltip } from './Tooltip'
import type { MobileAccess } from '../../../shared/types'

interface ConnectMobileButtonProps {
  wsColor: string
  txtColor: string
}

/**
 * Opens the Orchestra web app on a phone. The address is this Mac's Tailscale
 * MagicDNS name, so the only prerequisite is that the phone is signed into the
 * same tailnet — there is no sign-in, and nothing is exposed publicly.
 *
 * Rendered as a QR code because the URL is long, machine-specific and awkward
 * to type on a phone.
 */
export function ConnectMobileButton({ wsColor, txtColor }: ConnectMobileButtonProps) {
  const [open, setOpen] = useState(false)
  const [access, setAccess] = useState<MobileAccess | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Resolved on open rather than polled: it only changes when Tailscale does,
  // and the main process re-reads MagicDNS on every call.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCopied(false)
    void window.electronAPI.getMobileAccess().then(async (result) => {
      if (cancelled) return
      setAccess(result)
      if (!result.url) {
        setQr(null)
        return
      }
      // Fixed dark-on-white: the footer is tinted by the workspace color, and a
      // low-contrast QR is one a phone camera won't read.
      const dataUrl = await QRCode.toDataURL(result.url, {
        margin: 1,
        width: 320,
        color: { dark: '#000000', light: '#ffffff' },
      })
      if (!cancelled) setQr(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const copy = useCallback(() => {
    if (!access?.url) return
    void navigator.clipboard.writeText(access.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [access?.url])

  return (
    <div ref={rootRef} className="relative">
      <Tooltip side="top" text="Open Orchestra on your phone" bgColor={wsColor} textColor={txtColor}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
          style={{
            color: txtColor,
            backgroundColor: `${txtColor}10`,
            border: `1px solid ${txtColor}18`,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
            <path d="M9.5 9.5h2v2h-2zM13 13h1.5v1.5H13zM9.5 13h1.5v1.5H9.5zM13 9.5h1.5v1.5H13z" fill="currentColor" stroke="none" />
          </svg>
          <span>Connect to mobile</span>
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 w-[15rem] rounded-md shadow-xl border z-50 p-3"
          style={{
            backgroundColor: wsColor,
            borderColor: `${txtColor}20`,
            color: txtColor,
          }}
        >
          <div className="text-[11px] font-semibold mb-2">Connect to mobile</div>

          {!access && <div className="text-[10px] opacity-60 font-mono">Looking up Tailscale…</div>}

          {access?.url && (
            <>
              {qr ? (
                <img
                  src={qr}
                  alt={`QR code linking to ${access.url}`}
                  className="w-full rounded bg-white p-1.5"
                />
              ) : (
                <div className="w-full aspect-square rounded bg-white/10 animate-pulse" />
              )}
              <button
                onClick={copy}
                title="Copy to clipboard"
                className="mt-2 w-full text-left text-[9px] font-mono break-all rounded px-1.5 py-1 transition-colors hover:opacity-80"
                style={{ backgroundColor: `${txtColor}10`, border: `1px solid ${txtColor}18` }}
              >
                {copied ? 'Copied' : access.url}
              </button>
              <div className="mt-2 text-[9px] opacity-60 leading-snug">
                Scan with a phone signed into this tailnet. No password — the tailnet is the
                only way in.
              </div>
            </>
          )}

          {access?.problem && (
            <div
              className="mt-2 text-[9px] leading-snug rounded px-1.5 py-1"
              style={{ backgroundColor: '#eab30820', border: '1px solid #eab30840' }}
            >
              {access.problem}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
