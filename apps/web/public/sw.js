// Service worker for Orchestra Web: push notifications + document freshness.
// sw-version: 5 (bump to force a byte-diff so installed PWAs pick up changes)

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

// The notification's large icon, painted in the workspace's sidebar tint so a
// glance at the shade says WHICH workspace finished. The "O" is the badge's
// glyph, inked white on dark tints and near-black on light ones; a workspace
// emoji replaces it. Any failure falls back to the stock app icon.
const ICON_SIZE = 192;

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 160 ? "#111111" : "#ffffff";
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return "data:" + blob.type + ";base64," + btoa(binary);
}

async function workspaceIcon(color, emoji) {
  if (!isHexColor(color) || typeof OffscreenCanvas === "undefined") return "/icon-192.png";
  try {
    const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
    if (typeof emoji === "string" && emoji.trim()) {
      ctx.font = "116px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emoji.trim(), ICON_SIZE / 2, ICON_SIZE / 2 + 8);
    } else {
      const glyph = await createImageBitmap(await (await fetch("/badge-96.png")).blob());
      const ink = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
      const inkCtx = ink.getContext("2d");
      inkCtx.drawImage(glyph, 36, 36, 120, 120);
      inkCtx.globalCompositeOperation = "source-in";
      inkCtx.fillStyle = inkFor(color);
      inkCtx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
      ctx.drawImage(ink, 0, 0);
    }
    return await blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  } catch {
    return "/icon-192.png";
  }
}

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
    (async () => {
      const icon = await workspaceIcon(data.workspaceColor, data.workspaceEmoji);
      await self.registration.showNotification(title, {
        body,
        data: { sessionId },
        tag: sessionId || undefined,
        icon,
        // Android draws the badge as a mask: only alpha survives, tinted by the
        // system. The opaque app icon masked to a plain blob, so Android swapped
        // in a generic glyph. This is the "O" on transparency.
        badge: "/badge-96.png",
      });
    })(),
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
