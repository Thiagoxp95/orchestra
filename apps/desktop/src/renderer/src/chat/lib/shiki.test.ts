// Pure helpers only — the async highlighter itself (dynamic shiki import) is
// deliberately untested here.
import { describe, expect, it } from 'vitest'
import { fnv1a, highlightCacheKey, LruCache, resolveLang } from './shiki'

describe('fnv1a', () => {
  it('matches known FNV-1a 32-bit vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  it('is deterministic and content-sensitive', () => {
    expect(fnv1a('const x = 1')).toBe(fnv1a('const x = 1'))
    expect(fnv1a('const x = 1')).not.toBe(fnv1a('const x = 2'))
  })
})

describe('highlightCacheKey', () => {
  it('separates same code under different languages', () => {
    expect(highlightCacheKey('x', 'typescript')).not.toBe(highlightCacheKey('x', 'python'))
  })

  it('embeds length to blunt hash collisions', () => {
    expect(highlightCacheKey('abc', 'typescript')).toContain(':3:')
  })
})

describe('resolveLang', () => {
  it('maps aliases to canonical grammar ids', () => {
    expect(resolveLang('ts')).toBe('typescript')
    expect(resolveLang('js')).toBe('javascript')
    expect(resolveLang('shell')).toBe('shellscript')
    expect(resolveLang('sh')).toBe('shellscript')
    expect(resolveLang('py')).toBe('python')
    expect(resolveLang('md')).toBe('markdown')
    expect(resolveLang('diff')).toBe('diff')
  })

  it('is case-insensitive', () => {
    expect(resolveLang('TSX')).toBe('tsx')
    expect(resolveLang('Bash')).toBe('bash')
  })

  it('rejects unknown or empty languages', () => {
    expect(resolveLang('brainfuck')).toBeNull()
    expect(resolveLang('')).toBeNull()
    expect(resolveLang(undefined)).toBeNull()
    expect(resolveLang(null)).toBeNull()
  })
})

describe('LruCache', () => {
  it('stores and retrieves entries', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts the least recently used entry at capacity', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3) // evicts 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('get() refreshes recency', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'b' is now oldest
    cache.set('c', 3) // evicts 'b'
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })

  it('overwriting an existing key does not evict', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBe(2)
    expect(cache.size).toBe(2)
  })
})
