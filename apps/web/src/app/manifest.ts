import type { MetadataRoute } from "next";

// The manifest is a route handler, so a static export needs to be told it has
// no per-request behaviour worth preserving.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orchestra Web",
    short_name: "Orchestra",
    description: "Remote client for Orchestra — control your workspaces and terminal sessions.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
