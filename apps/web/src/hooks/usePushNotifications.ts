'use client'
import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { anyApi } from "convex/server";
import { urlBase64ToUint8Array, isStandalone, shouldAutoResubscribe } from "../lib/push";

type Status = "unsupported" | "not-installed" | "default" | "granted" | "denied";

export function usePushNotifications(token: string) {
  const [status, setStatus] = useState<Status>("default");
  const subscribe = useMutation(anyApi.remote.subscribe);

  // Subscribe (idempotent) and upsert the subscription to the backend.
  // Assumes notification permission is already granted.
  const syncSubscription = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) {
      console.warn("NEXT_PUBLIC_VAPID_PUBLIC_KEY not set");
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
      token,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
  }, [token, subscribe]);

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
