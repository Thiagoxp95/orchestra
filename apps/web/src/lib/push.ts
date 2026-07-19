/** Convert a VAPID public key (base64url) to the Uint8Array applicationServerKey. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * True when the app should silently refresh its push subscription on launch.
 * Push services expire/rotate subscriptions (iOS especially), and the backend
 * prunes rows that return 404/410 — without a re-subscribe on launch the first
 * expiry silences notifications forever. Only when permission is already
 * granted (never prompts) and only in the installed PWA.
 */
export function shouldAutoResubscribe(
  permission: NotificationPermission,
  standalone: boolean,
): boolean {
  return permission === "granted" && standalone;
}

/** True when running as an installed standalone PWA (iOS Safari or others). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone;
  return iosStandalone === true || window.matchMedia("(display-mode: standalone)").matches;
}
