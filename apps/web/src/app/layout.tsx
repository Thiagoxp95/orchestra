import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "../components/Providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Orchestra Web",
  description: "Remote client for Orchestra — control your workspaces and terminal sessions.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Orchestra" },
};

// interactiveWidget: Chrome/Android otherwise leaves the layout viewport at full
// height when the soft keyboard opens, exactly like iOS. Asking it to resize the
// layout keeps the shell above the keyboard there too (iOS ignores the hint — the
// visual-viewport tracking in lib/viewport.ts is what covers it).
//
// initialScale/maximumScale/userScalable: the app owns the pinch gesture (two
// fingers inward zooms out to the sessions overview), so a browser pinch-zoom on
// top of it is never something the user asked for — and it is a trap, not just a
// nuisance. Zoomed in, the layout viewport stays wider than the visible strip and
// the right edge of the shell is simply cut off; the only way back would be to
// pinch out, which this app has already spent on its own gestures (two fingers
// out of a session, three on the terminal's font size). So
// the page is pinned at 1:1. Chrome/Android honours the meta tag; iOS Safari has
// ignored user-scalable since iOS 10, which is what the gesture handlers and
// `touch-action` in globals.css cover.
export const viewport = {
  themeColor: "#0a0a0a",
  viewportFit: "cover" as const,
  interactiveWidget: "resizes-content" as const,
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
