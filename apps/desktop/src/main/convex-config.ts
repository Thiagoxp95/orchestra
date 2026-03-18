// Shared Convex deployment URLs.
// Loaded from .env (prod) or .env.development (dev) by electron-vite.
// The MAIN_VITE_ prefix exposes vars to the main process via import.meta.env.

export const CONVEX_CLOUD_URL = import.meta.env.MAIN_VITE_CONVEX_CLOUD_URL as string
export const CONVEX_SITE_URL = import.meta.env.MAIN_VITE_CONVEX_SITE_URL as string
