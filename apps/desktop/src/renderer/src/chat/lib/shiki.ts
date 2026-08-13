// Lazy Shiki syntax highlighting for chat code blocks.
//
// Shiki (grammar files included) is far too heavy for the initial bundle, so
// the module is dynamically imported the first time a fenced code block asks
// for color. One singleton highlighter is shared app-wide; languages load on
// demand from a small allowlist (agent transcripts are overwhelmingly
// code/config in these languages — anything else stays a plain <pre>).
//
// highlight() returns the rendered HTML or null; null means "keep your plain
// fallback" (unknown language, oversized block, or any load/render failure).
// Callers never need a try/catch.

import type { BundledLanguage, Highlighter } from 'shiki'

// Dual themes: token spans carry BOTH palettes as CSS vars
// (--shiki-dark/--shiki-light) and globals.css picks one off the workspace
// tint (:root[data-tint]). A single fixed dark theme rendered near-invisible
// pastels on light-tinted workspaces.
const THEME_DARK = 'one-dark-pro'
const THEME_LIGHT = 'one-light'

/** Above this, tokenization cost outweighs the color — plain pre wins. */
export const MAX_HIGHLIGHT_CHARS = 20_000

/**
 * Fence alias → Shiki grammar id. Doubles as the allowlist: anything not in
 * here is rendered unhighlighted rather than pulling a grammar we never
 * bundled for.
 */
const LANG_ALIASES: Record<string, BundledLanguage> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  bash: 'bash',
  sh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  zsh: 'shellscript',
  python: 'python',
  py: 'python',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
  markdown: 'markdown',
}

/** Canonical grammar id for a fence language, or null when unsupported. */
export function resolveLang(lang: string | null | undefined): BundledLanguage | null {
  if (!lang) return null
  return LANG_ALIASES[lang.toLowerCase()] ?? null
}

/** FNV-1a 32-bit over charCodes — cheap content fingerprint for cache keys. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * Tiny Map-backed LRU. get() refreshes recency; set() evicts the least
 * recently used entry once capacity is hit.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
    this.map.set(key, value)
  }
}

/**
 * Cache key: content hash + length + language. The length guards the 1-in-4B
 * hash collision from silently rendering the wrong block's colors.
 */
export function highlightCacheKey(code: string, lang: string): string {
  return `${fnv1a(`${lang}\n${code}`).toString(36)}:${code.length}:${lang}`
}

const htmlCache = new LruCache<string, string>(200)

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    const promise = import('shiki').then((shiki) =>
      shiki.createHighlighter({ themes: [THEME_DARK, THEME_LIGHT], langs: [] }),
    )
    // A failed load (offline chunk fetch) must not poison the singleton — the
    // next block retries the import.
    promise.catch(() => {
      if (highlighterPromise === promise) highlighterPromise = null
    })
    highlighterPromise = promise
  }
  return highlighterPromise
}

/** In-flight grammar loads, deduped so parallel blocks share one fetch. */
const langLoads = new Map<string, Promise<boolean>>()

function ensureLanguage(highlighter: Highlighter, lang: BundledLanguage): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang)) return Promise.resolve(true)
  let load = langLoads.get(lang)
  if (!load) {
    load = highlighter
      .loadLanguage(lang)
      .then(() => true)
      .catch(() => {
        langLoads.delete(lang)
        return false
      })
    langLoads.set(lang, load)
  }
  return load
}

/**
 * Highlight `code` as `lang`. Resolves to Shiki's HTML (its own
 * `<pre class="shiki">…`) or null when the caller should keep its plain
 * fallback. Never rejects.
 */
export async function highlight(code: string, lang: string): Promise<string | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null
  const resolved = resolveLang(lang)
  if (!resolved) return null
  const key = highlightCacheKey(code, resolved)
  const cached = htmlCache.get(key)
  if (cached !== undefined) return cached
  try {
    const highlighter = await getHighlighter()
    if (!(await ensureLanguage(highlighter, resolved))) return null
    const html = highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { dark: THEME_DARK, light: THEME_LIGHT },
      defaultColor: false,
    })
    htmlCache.set(key, html)
    return html
  } catch {
    return null
  }
}
