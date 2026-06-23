'use client'
import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { anyApi } from "convex/server";
import { urlBase64ToUint8Array, isStandalone } from "../lib/push";

type Status = "unsupported" | "not-installed" | "default" | "granted" | "denied";

export function usePushNotifications(token: string) {
  const [status, setStatus] = useState<Status>("default");
  const subscribe = useMutation(anyApi.remote.subscribe);

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
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    setStatus(Notification.permission as Status);

    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "attach-session" && e.data.sessionId) {
        window.dispatchEvent(new CustomEvent("attach-session", { detail: e.data.sessionId }));
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  const enable = useCallback(async () => {
    const permission = await Notification.requestPermission();
    setStatus(permission as Status);
    if (permission !== "granted") return;

    const reg = await navigator.serviceWorker.ready;
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) {
      console.warn("NEXT_PUBLIC_VAPID_PUBLIC_KEY not set");
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as unknown as ArrayBuffer,
    });
    const json = sub.toJSON();
    await subscribe({
      token,
      endpoint: json.endpoint!,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
    });
  }, [token, subscribe]);

  return { status, enable };
}
