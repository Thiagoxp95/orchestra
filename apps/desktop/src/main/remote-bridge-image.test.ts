import { describe, expect, it } from 'vitest'
import {
  IMAGE_MAX_AGE_MS,
  imageExtension,
  imageFileName,
  normalizeSendImagePayload,
  selectStaleImages,
} from './remote-bridge-image'

describe('normalizeSendImagePayload', () => {
  it('coerces fields to strings', () => {
    expect(normalizeSendImagePayload({ storageId: 'st123', mime: 'image/png' })).toEqual({
      storageId: 'st123',
      mime: 'image/png',
    })
  })

  it('defaults missing fields to empty string / png mime', () => {
    expect(normalizeSendImagePayload(undefined)).toEqual({ storageId: '', mime: 'image/png' })
    expect(normalizeSendImagePayload({})).toEqual({ storageId: '', mime: 'image/png' })
  })
})

describe('imageExtension', () => {
  it('maps common image mimes', () => {
    expect(imageExtension('image/png')).toBe('png')
    expect(imageExtension('image/jpeg')).toBe('jpg')
    expect(imageExtension('image/webp')).toBe('webp')
    expect(imageExtension('image/gif')).toBe('gif')
    expect(imageExtension('image/heic')).toBe('heic')
  })

  it('falls back to png for unknown or junk mimes', () => {
    expect(imageExtension('application/pdf')).toBe('png')
    expect(imageExtension('')).toBe('png')
    expect(imageExtension('image/svg+xml')).toBe('png')
  })
})

describe('imageFileName', () => {
  it('builds a timestamped name with the mime extension', () => {
    expect(imageFileName('image/jpeg', 1700000000000)).toMatch(/^remote-1700000000000(-\d+)?\.jpg$/)
  })

  it('never collides for the same timestamp', () => {
    const a = imageFileName('image/png', 42)
    const b = imageFileName('image/png', 42)
    expect(a).not.toBe(b)
  })
})

describe('selectStaleImages', () => {
  const now = 1700000000000
  it('selects only files older than the max age', () => {
    const entries = [
      { name: 'old.png', mtimeMs: now - IMAGE_MAX_AGE_MS - 1 },
      { name: 'fresh.png', mtimeMs: now - 1000 },
      { name: 'edge.png', mtimeMs: now - IMAGE_MAX_AGE_MS },
    ]
    expect(selectStaleImages(entries, now)).toEqual(['old.png'])
  })

  it('returns empty for no entries', () => {
    expect(selectStaleImages([], now)).toEqual([])
  })
})
