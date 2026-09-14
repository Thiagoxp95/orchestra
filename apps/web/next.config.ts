import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// One id per build, inlined at compile time into the client bundle. A
// long-lived phone page compares its inlined copy against /build-id.txt — which
// the desktop serves from this same build — to learn that the app it is running
// has been superseded (see lib/build-freshness.ts). Written by
// scripts/stamp-build-id.mjs, which the build script runs first.
function buildId(): string {
  try {
    return readFileSync(resolve(__dirname, "public/build-id.txt"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

const nextConfig: NextConfig = {
  // A static export, served by the Orchestra desktop app rather than by a
  // Node server of its own. That is what makes the phone and the desktop
  // impossible to version-skew: they are one artifact.
  output: "export",
  // Shared chat protocol and Bun's dependencies live above apps/web.
  turbopack: { root: resolve(__dirname, "../..") },
  outputFileTracingRoot: resolve(__dirname, "../.."),
  env: { NEXT_PUBLIC_BUILD_ID: buildId() },
  // Cache headers are set by the desktop's static handler
  // (apps/desktop/src/main/local-server/static-files.ts): the HTML shell is
  // no-store because iOS relaunches a home-screen PWA from its cached start
  // page without revalidating, while hashed /_next/static assets stay
  // immutable.
};

export default nextConfig;
