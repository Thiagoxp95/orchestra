// src/main/mobile-access.ts
//
// The URL a phone uses to reach this Mac's Orchestra web app, and how far the
// Mac is from being reachable. The app's local server binds to loopback and
// Tailscale Serve publishes it, so the address is always the machine's own
// MagicDNS name on the Serve port — nothing to configure, nothing exposed to
// the public internet.
//
// Everything a person has to do is expressed as one `step` so the popover can
// show one instruction and one button at a time.

import type { MobileAccess } from '../shared/types'
import { resetTailnetHostCache } from './running-servers'
import {
  findTailscale,
  publishServe,
  readServeRoute,
  readTailscaleStatus,
  unpublishServe,
  type PublishResult,
  type ServeRoute,
  type TailscaleStatus,
} from './tailscale'

/**
 * Tailscale Serve port fronting the app's own local server on 127.0.0.1:13000.
 * Must match the port infra/tailscale/setup.py publishes.
 */
export const MOBILE_WEB_PORT = Number(process.env.ORCHESTRA_MOBILE_WEB_PORT) || 8445

/** Loopback port the local server (src/main/local-server) listens on. */
export const LOCAL_WEB_PORT = Number(process.env.ORCHESTRA_LOCAL_WEB_PORT) || 13000

export const SERVE_TARGET = `http://127.0.0.1:${LOCAL_WEB_PORT}`

export interface MobileAccessInputs {
  tailscale: TailscaleStatus
  route: ServeRoute
  /** Is the local server actually up? A QR to a dead port is worse than a warning. */
  webServed: boolean
  port?: number
}

/** Pure: turn what we observed into the one thing the user should do next. */
export function buildMobileAccess(inputs: MobileAccessInputs): MobileAccess {
  const { tailscale, route, webServed } = inputs
  const port = inputs.port ?? MOBILE_WEB_PORT
  const host = tailscale.dnsName
  const url = host ? `https://${host}:${port}` : null

  if (!tailscale.installed) {
    return {
      url: null, host: null, step: 'install-tailscale', published: false,
      problem: 'Tailscale is not installed on this Mac. It is what lets your phone reach this computer privately.',
    }
  }
  if (tailscale.backendState !== 'Running') {
    return {
      url: null, host: null, step: 'open-tailscale', published: false,
      problem: tailscale.backendState === 'NeedsLogin'
        ? 'Tailscale is installed but not signed in. Open it and sign in, then come back.'
        : 'Tailscale is installed but not connected. Open it and turn it on.',
    }
  }
  if (!host) {
    return {
      url: null, host: null, step: 'enable-magicdns', published: false,
      problem: 'Turn on MagicDNS for your tailnet (Tailscale admin console → DNS). Serve needs it for an HTTPS address.',
    }
  }
  if (route.funnel) {
    return {
      url, host, step: 'publish', published: false,
      problem: `Port ${port} is exposed to the public internet with Tailscale Funnel. Turn Funnel off for it first.`,
    }
  }
  if (route.proxy && route.proxy !== SERVE_TARGET) {
    return {
      url, host, step: 'publish', published: false,
      problem: `Tailscale port ${port} already points at ${route.proxy}. Free it, or change ORCHESTRA_MOBILE_WEB_PORT.`,
    }
  }
  if (!route.proxy) {
    return { url, host, step: 'publish', published: false, problem: null }
  }
  return {
    url, host, step: 'ready', published: true,
    problem: webServed
      ? null
      : `The app's local server is not answering on port ${LOCAL_WEB_PORT}. Restart Orchestra, then try again.`,
  }
}

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

/** Resolve the phone URL and setup step now. Bypasses the MagicDNS cache: this
 *  runs on a click, and the usual reason for clicking twice is having just
 *  fixed Tailscale. */
export async function resolveMobileAccess(): Promise<MobileAccess> {
  resetTailnetHostCache()
  const bin = findTailscale()
  const [tailscale, route, webServed] = await Promise.all([
    readTailscaleStatus(bin),
    readServeRoute(MOBILE_WEB_PORT, bin),
    isWebServed(),
  ])
  return buildMobileAccess({ tailscale, route, webServed })
}

/** The "Publish on my tailnet" button. */
export async function publishMobileAccess(): Promise<PublishResult> {
  return publishServe(MOBILE_WEB_PORT, LOCAL_WEB_PORT)
}

export async function unpublishMobileAccess(): Promise<PublishResult> {
  return unpublishServe(MOBILE_WEB_PORT)
}
