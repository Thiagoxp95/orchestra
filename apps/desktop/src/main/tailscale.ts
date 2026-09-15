// src/main/tailscale.ts
//
// The few Tailscale CLI calls the phone setup needs, so the whole thing can be
// driven from the Connect-to-mobile popover: is Tailscale installed, is it
// connected with a MagicDNS name, is our Serve route published, publish it.
// This is what infra/tailscale/setup.py does, for people who never open a
// terminal.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Where the CLI lives on macOS: App Store / standalone app, Homebrew, manual. */
const TAILSCALE_BINARIES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
]

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/mac'
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns'

interface Exec {
  code: number
  stdout: string
  stderr: string
}

function exec(bin: string, args: string[], timeoutMs = 8000): Promise<Exec> {
  return new Promise((resolve) => {
    // Without a terminal env (Electron launched from Finder) the app binary
    // assumes a GUI launch and prints "The Tailscale GUI failed to start"
    // instead of running the command. TAILSCALE_BE_CLI forces CLI mode.
    const env = { ...process.env, TAILSCALE_BE_CLI: '1' }
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export function findTailscale(): string | null {
  return TAILSCALE_BINARIES.find((bin) => existsSync(bin)) ?? null
}

export interface TailscaleStatus {
  installed: boolean
  /** BackendState from `tailscale status`: Running, NeedsLogin, Stopped… */
  backendState: string | null
  /** MagicDNS name without the trailing dot, when the tailnet has MagicDNS. */
  dnsName: string | null
}

export async function readTailscaleStatus(bin: string | null = findTailscale()): Promise<TailscaleStatus> {
  if (!bin) return { installed: false, backendState: null, dnsName: null }
  const result = await exec(bin, ['status', '--json'], 4000)
  try {
    const parsed = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string } }
    const dns = parsed.Self?.DNSName?.replace(/\.$/, '') || null
    return {
      installed: true,
      backendState: parsed.BackendState ?? null,
      dnsName: dns && dns.endsWith('.ts.net') ? dns : null,
    }
  } catch {
    // The app is installed but its daemon is not answering (not launched yet).
    return { installed: true, backendState: null, dnsName: null }
  }
}

export interface ServeRoute {
  /** What Serve proxies on our HTTPS port, or null when nothing is published. */
  proxy: string | null
  /** Funnel exposes the port to the public internet — never what we want. */
  funnel: boolean
}

/** Parse `tailscale serve status --json` for one HTTPS port. */
export function parseServeRoute(json: string, port: number): ServeRoute {
  try {
    const parsed = JSON.parse(json) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      AllowFunnel?: Record<string, boolean>
    }
    let proxy: string | null = null
    for (const [hostPort, entry] of Object.entries(parsed.Web ?? {})) {
      if (!hostPort.endsWith(`:${port}`)) continue
      proxy = entry.Handlers?.['/']?.Proxy ?? null
      break
    }
    const funnel = Object.entries(parsed.AllowFunnel ?? {}).some(
      ([hostPort, on]) => on && hostPort.endsWith(`:${port}`),
    )
    return { proxy, funnel }
  } catch {
    return { proxy: null, funnel: false }
  }
}

export async function readServeRoute(port: number, bin: string | null = findTailscale()): Promise<ServeRoute> {
  if (!bin) return { proxy: null, funnel: false }
  const result = await exec(bin, ['serve', 'status', '--json'], 4000)
  return parseServeRoute(result.stdout, port)
}

export interface PublishResult {
  ok: boolean
  /** Human-readable reason, when not ok. */
  error?: string
  /** Enabling HTTPS certificates is done in the admin console, not the CLI. */
  needsHttpsCerts?: boolean
}

/** Make `tailscale serve` front the local server with HTTPS on the tailnet. */
export async function publishServe(
  mobilePort: number,
  localPort: number,
  bin: string | null = findTailscale(),
): Promise<PublishResult> {
  if (!bin) return { ok: false, error: 'Tailscale is not installed.' }
  const target = `http://127.0.0.1:${localPort}`
  const result = await exec(bin, ['serve', '--bg', `--https=${mobilePort}`, target], 20_000)
  if (result.code === 0) return { ok: true }
  const text = (result.stderr || result.stdout).trim()
  // "HTTPS certificates are not enabled" / "enable HTTPS in the admin console"
  const needsHttpsCerts = /https/i.test(text) && /(not enabled|enable|cert)/i.test(text)
  return {
    ok: false,
    needsHttpsCerts,
    error: needsHttpsCerts
      ? 'HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin console (DNS tab), then try again.'
      : text || `tailscale serve failed (exit ${result.code})`,
  }
}

export async function unpublishServe(mobilePort: number, bin: string | null = findTailscale()): Promise<PublishResult> {
  if (!bin) return { ok: false, error: 'Tailscale is not installed.' }
  const result = await exec(bin, ['serve', `--https=${mobilePort}`, 'off'], 10_000)
  return result.code === 0 ? { ok: true } : { ok: false, error: (result.stderr || result.stdout).trim() }
}
