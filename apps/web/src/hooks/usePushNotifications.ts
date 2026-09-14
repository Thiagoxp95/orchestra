'use client'
import { useCallback, useEffect, useState } from "react";
import { api, useMutation } from "../lib/sync";
import { urlBase64ToUint8Array, isStandalone, shouldAutoResubscribe } from "../lib/push";

type Status = "unsupported" | "not-installed" | "default" | "granted" | "denied";

/**
 * The desktop generates its own VAPID keypair on first run, so the public key
 * can't be baked into this bundle — it's fetched from the machine serving us.
 */
async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) return null;
    const config = (await res.json()) as { vapidPublicKey?: string };
    return config.vapidPublicKey ?? null;
  } catch {
    return null;
  }
}

export function usePushNotifications() {
  const [status, setStatus] = useState<Status>("default");
  const subscribe = useMutation(api.remote.subscribe);

  // Subscribe (idempotent) and upsert the subscription to the desktop.
  // Assumes notification permission is already granted.
  const syncSubscription = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    const key = await fetchVapidPublicKey();
    if (!key) {
      console.warn("Desktop did not return a VAPID public key");
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
    });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      console.warn("Push subscription missing fields; not subscribing");
      return;
    }
    await subscribe({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
  }, [subscribe]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (!isStandalone()) {
      setStatus("not-installed");
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW registration failed:", err));
    setStatus(Notification.permission as Status);

    // Self-heal: push services expire/rotate subscriptions and the backend
    // prunes dead ones, so refresh the subscription on every launch. Without
    // this the first expiry silences notifications forever (the enable button
    // never re-renders once permission is granted).
    if (shouldAutoResubscribe(Notification.permission, true)) {
      syncSubscription().catch((err) => console.warn("Push auto-resubscribe failed:", err));
    }

    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "attach-session" && e.data.sessionId) {
        window.dispatchEvent(new CustomEvent("attach-session", { detail: e.data.sessionId }));
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [syncSubscription]);

  const enable = useCallback(async () => {
    const permission = await Notification.requestPermission();
    setStatus(permission as Status);
    if (permission !== "granted") return;
    await syncSubscription();
  }, [syncSubscription]);

  return { status, enable };
}
