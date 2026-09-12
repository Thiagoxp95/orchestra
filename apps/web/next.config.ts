import type { NextConfig } from "next";
import { resolve } from "node:path";

// One id per build, inlined at compile time into BOTH the client bundle and the
// /api/build-id route. A long-lived phone page compares its inlined copy against
// the route's answer to learn a newer deployment exists (see lib/build-freshness.ts).
const buildId = Date.now().toString(36);

const nextConfig: NextConfig = {
  // Keep the supervised phone build separate from local development and QA.
  distDir: process.env.ORCHESTRA_WEB_DIST_DIR ?? '.next',
  // Shared chat protocol and Bun's dependencies live above apps/web. Vercel's
  // local build otherwise constrains Turbopack to the app directory.
  turbopack: { root: resolve(__dirname, "../..") },
  outputFileTracingRoot: resolve(__dirname, "../.."),
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  // The document must never be cacheable: iOS serves a home-screen PWA's
  // cached start page on launch without revalidating, stranding phones on
  // days-old bundles. Hashed /_next/static assets keep their long-lived
  // caching — only the HTML shell pays the (tiny) refetch.
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
