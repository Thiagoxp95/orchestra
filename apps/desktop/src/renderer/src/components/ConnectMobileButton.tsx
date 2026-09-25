import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Tooltip } from './Tooltip'
import type { MobileAccess, MobileAccessStep } from '../../../shared/types'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/mac'
const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns'

/** One instruction and one button per step, so a first-time user never
 *  sees a terminal, a script, or two choices at once. */
const STEPS: Record<Exclude<MobileAccessStep, 'ready'>, { n: number; title: string; action: string }> = {
  'install-tailscale': { n: 1, title: 'Install Tailscale', action: 'Get Tailscale' },
  'open-tailscale': { n: 2, title: 'Sign in to Tailscale', action: 'Open Tailscale' },
  'enable-magicdns': { n: 3, title: 'Turn on MagicDNS', action: 'Open Tailscale DNS settings' },
  publish: { n: 4, title: 'Publish on your tailnet', action: 'Publish' },
}

interface ConnectMobileButtonProps {
  wsColor: string
  txtColor: string
}

/**
 * Opens the Orchestra web app on a phone. The address is this Mac's Tailscale
 * MagicDNS name, so the only prerequisite is that the phone is signed into the
 * same tailnet — there is no sign-in, and nothing is exposed publicly.
 *
 * The popover walks through whatever is still missing (install Tailscale,
 * sign in, MagicDNS, publish) one step at a time, then shows the QR code —
 * rendered as a QR because the URL is long, machine-specific and awkward to
 * type on a phone.
 */
export function ConnectMobileButton({ wsColor, txtColor }: ConnectMobileButtonProps) {
  const [open, setOpen] = useState(false)
  const [access, setAccess] = useState<MobileAccess | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [needsHttpsCerts, setNeedsHttpsCerts] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
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
  }, [open, refreshKey])

  // While a step is being done elsewhere (the Tailscale app, the admin
  // console), re-check every few seconds so the popover advances by itself.
  useEffect(() => {
    if (!open || !access || access.step === 'ready' || busy) return
    const timer = setInterval(() => setRefreshKey((k) => k + 1), 4000)
    return () => clearInterval(timer)
  }, [open, access, busy])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const runStep = useCallback(async () => {
    if (!access || busy) return
    setActionError(null)
    setBusy(true)
    try {
      switch (access.step) {
        case 'install-tailscale':
          await window.electronAPI.openExternalUrl(TAILSCALE_DOWNLOAD_URL)
          break
        case 'open-tailscale':
          await window.electronAPI.openTailscaleApp()
          break
        case 'enable-magicdns':
          await window.electronAPI.openExternalUrl(TAILSCALE_DNS_ADMIN_URL)
          break
        case 'publish': {
          const result = await window.electronAPI.publishMobileAccess()
          if (!result.ok) {
            setActionError(result.error ?? 'Publishing failed.')
            setNeedsHttpsCerts(Boolean(result.needsHttpsCerts))
          } else {
            setNeedsHttpsCerts(false)
          }
          break
        }
        default:
          break
      }
    } finally {
      setBusy(false)
      refresh()
    }
  }, [access, busy, refresh])

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

          {access && access.step !== 'ready' && (
            <div className="text-[10px] leading-snug">
              <div className="font-semibold mb-1">
                Step {STEPS[access.step].n} of 4 · {STEPS[access.step].title}
              </div>
              <div className="opacity-70 mb-2">
                {access.step === 'publish' && !access.problem
                  ? 'Last step: make this Mac reachable from your phone over your tailnet. Nothing is exposed to the internet.'
                  : access.problem}
              </div>
              <button
                onClick={() => void runStep()}
                disabled={busy || (access.step === 'publish' && !!access.problem)}
                className="w-full rounded px-2 py-1 text-[10px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ backgroundColor: `${txtColor}20`, border: `1px solid ${txtColor}30` }}
              >
                {busy ? 'Working…' : STEPS[access.step].action}
              </button>
              {actionError && (
                <div
                  className="mt-2 text-[9px] leading-snug rounded px-1.5 py-1"
                  style={{ backgroundColor: '#ef444420', border: '1px solid #ef444440' }}
                >
                  {actionError}
                  {needsHttpsCerts && (
                    <button
                      onClick={() => void window.electronAPI.openExternalUrl(TAILSCALE_DNS_ADMIN_URL)}
                      className="mt-1 block underline hover:opacity-80"
                    >
                      Open Tailscale DNS settings
                    </button>
                  )}
                </div>
              )}
              {access.step !== 'publish' && (
                <div className="mt-2 text-[9px] opacity-50 leading-snug">
                  This checks again by itself once that is done.
                </div>
              )}
            </div>
          )}

          {access?.step === 'ready' && access.url && (
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
              <button
                onClick={() => setShowHelp((v) => !v)}
                className="mt-1.5 w-full text-left text-[9px] underline opacity-60 hover:opacity-90"
              >
                Phone says it can&rsquo;t reach this?
              </button>
              {showHelp && (
                <div className="mt-1 text-[9px] leading-snug opacity-75 space-y-1">
                  <div>
                    That address only exists inside MagicDNS, so it fails whenever the
                    phone&rsquo;s Tailscale DNS isn&rsquo;t answering — even while the VPN is
                    connected and pings go through.
                  </div>
                  <div>
                    <span className="font-semibold">Fix:</span> force-stop the Tailscale app
                    (long-press its icon → App info → Force stop), open it, reconnect. Turning
                    the VPN off and on is not enough.
                  </div>
                  <div>
                    Still failing? In the Tailscale app, check “Use Tailscale DNS” is on, and on
                    Android set Private DNS to Off or Automatic.
                  </div>
                  <div className="opacity-70">
                    It has to be this HTTPS address: installing the app to your home screen
                    needs a trusted certificate, and the certificate is only valid for this
                    name.
                  </div>
                </div>
              )}
            </>
          )}

          {access?.step === 'ready' && access.problem && (
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
