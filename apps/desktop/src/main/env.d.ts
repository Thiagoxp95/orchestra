/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Fine-grained GitHub PAT (contents: read on this repo only) baked in at
  // build time so the updater can reach a PRIVATE repo's releases API.
  // Injected via CI secret — never committed to .env. Empty in dev builds.
  readonly MAIN_VITE_UPDATER_GH_TOKEN: string
}
