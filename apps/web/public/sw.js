// Service worker for Orchestra Web: push notifications + document freshness.
// sw-version: 3 (bump to force a byte-diff so installed PWAs pick up changes)

// iOS serves a home-screen app's cached START-PAGE HTML on launch without
// revalidating — even after a force-close — so a phone could run a days-old
// bundle while prod had long moved on (the "we fixed the picker three times"
// saga). A navigation fetch handler sits BEFORE the HTTP cache: forcing
// no-store here means every document load truly asks the network, while
// hashed /_next/static assets keep their ordinary caching. Offline falls
// back to whatever the cache still has.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() => fetch(req)));
  }
});

// Take over without waiting for every client to close…
self.addEventListener("install", () => {
  self.skipWaiting();
});

// …and reload existing pages once through the handler above. Any client alive
// at activation predates this SW version, so it may be running a stale bundle
// the page itself can never detect (the build-freshness hook ships IN the
// bundle). One navigate per activation — activation happens once per version,
// so this cannot loop.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const wins = await self.clients.matchAll({ type: "window" });
      // Issue the navigations WITHOUT awaiting them: a navigation's document
      // fetch is queued until the worker finishes activating, so awaiting it
      // here deadlocks activation (verified live — SW stuck "activating").
      for (const c of wins) {
        if ("navigate" in c) void c.navigate(c.url).catch(() => null);
      }
    })(),
  );
});

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
