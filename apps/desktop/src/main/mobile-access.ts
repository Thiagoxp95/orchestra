// src/main/mobile-access.ts
//
// The URL a phone uses to reach this Mac's Orchestra web app. The app's local
// server binds to loopback and Tailscale Serve publishes it, so the address is
// always the machine's own MagicDNS name on the Serve port — there is nothing
// to configure and nothing to expose to the public internet.

import { readTailnetHost, resetTailnetHostCache } from './running-servers'

/**
 * Tailscale Serve port fronting the app's own local server on 127.0.0.1:13000.
 * Must match the port infra/tailscale/setup.py publishes.
 */
export const MOBILE_WEB_PORT = Number(process.env.ORCHESTRA_MOBILE_WEB_PORT) || 8445

/** Loopback port the local server (src/main/local-server) listens on. */
export const LOCAL_WEB_PORT = Number(process.env.ORCHESTRA_LOCAL_WEB_PORT) || 13000

export interface MobileAccess {
  /** Absolute https URL for the phone, or null when it can't be determined. */
  url: string | null
  /** MagicDNS name backing the URL. */
  host: string | null
  /** Why there is no URL, or why the URL may not load. Null when all is well. */
  problem: string | null
}

/**
 * A MagicDNS name is `machine.tailnet.ts.net`. Anything else means Tailscale is
 * signed in but MagicDNS is off, which Serve requires for an HTTPS certificate.
 */
export function buildMobileAccess(
  host: string | undefined,
  webServed: boolean,
  port: number = MOBILE_WEB_PORT,
): MobileAccess {
  if (!host) {
    return {
      url: null,
      host: null,
      problem: 'Tailscale is not running on this Mac. Start it and sign in, then try again.',
    }
  }
  if (!host.endsWith('.ts.net')) {
    return {
      url: null,
      host,
      problem: 'Enable MagicDNS in the Tailscale admin console — Serve needs it to issue a certificate.',
    }
  }
  return {
    url: `https://${host}:${port}`,
    host,
    problem: webServed
      ? null
      : `The app's local server is not answering on port ${LOCAL_WEB_PORT}. Restart Orchestra, then try again.`,
  }
}

/** Is the local server actually up? A QR to a dead port is worse than a warning. */
async function isWebServed(port: number = LOCAL_WEB_PORT): Promise<boolean> {
  const abort = AbortSignal.timeout(1500)
  try {
    // Any answer proves something is listening; the status code is irrelevant.
    await fetch(`http://127.0.0.1:${port}/api/config`, { signal: abort })
    return true
  } catch {
    return false
  }
}

/** Resolve the phone URL now. Bypasses the MagicDNS cache: this runs on a
 *  click, and the usual reason for clicking twice is having just fixed
 *  Tailscale. */
export async function resolveMobileAccess(): Promise<MobileAccess> {
  resetTailnetHostCache()
  const [host, webServed] = await Promise.all([readTailnetHost(), isWebServed()])
  return buildMobileAccess(host, webServed)
}
