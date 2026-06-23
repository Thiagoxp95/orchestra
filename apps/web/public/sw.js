// Service worker for Orchestra Web push notifications.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Orchestra";
  const body = data.body || "";
  const sessionId = data.sessionId || null;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { sessionId },
      tag: sessionId || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => "focus" in c);
      if (client) {
        await client.focus();
        client.postMessage({ type: "attach-session", sessionId });
      } else {
        await self.clients.openWindow("/?session=" + encodeURIComponent(sessionId || ""));
      }
    })(),
  );
});
