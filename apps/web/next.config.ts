import type { NextConfig } from "next";

// One id per build, inlined at compile time into BOTH the client bundle and the
// /api/build-id route. A long-lived phone page compares its inlined copy against
// the route's answer to learn a newer deployment exists (see lib/build-freshness.ts).
const buildId = Date.now().toString(36);

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
};

export default nextConfig;
