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
export const viewport = {
  themeColor: "#0a0a0a",
  viewportFit: "cover" as const,
  interactiveWidget: "resizes-content" as const,
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
