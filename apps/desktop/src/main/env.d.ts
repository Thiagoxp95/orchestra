/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_CONVEX_CLOUD_URL: string
  readonly MAIN_VITE_CONVEX_SITE_URL: string
  readonly MAIN_VITE_DEVICE_SECRET: string
  // Fine-grained GitHub PAT (contents: read on this repo only) baked in at
  // build time so the updater can reach a PRIVATE repo's releases API.
  // Injected via CI secret — never committed to .env. Empty in dev builds.
  readonly MAIN_VITE_UPDATER_GH_TOKEN: string
}
