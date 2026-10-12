"use client";

// Replaces Next's bare "Application error" page. In the installed PWA there is
// no address bar to reload from, so without this a crash meant force-closing the app.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ padding: 24, maxWidth: 420, textAlign: "center" }}>
          <p style={{ fontSize: 16, margin: "0 0 8px" }}>Orchestra hit an error.</p>
          <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 20px", wordBreak: "break-word" }}>{error.message}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 20px", fontSize: 15, borderRadius: 8, border: "1px solid #333", background: "#1a1a1a", color: "inherit" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
