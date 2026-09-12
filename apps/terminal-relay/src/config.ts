/** Tailscale Serve is the sole remote ingress; never bind the relay to the LAN. */
export function relayConfig(env: Record<string, string | undefined>) {
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!origins.length) throw new Error('ALLOWED_ORIGINS requires a Tailscale HTTPS origin')
  for (const origin of origins) {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS must contain exact Tailscale HTTPS origins')
    }
  }
  const port = Number(env.PORT ?? 18080)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port')
  return { host: '127.0.0.1', port, origins }
}
