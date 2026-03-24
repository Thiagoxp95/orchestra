import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from './types'
import { getVisibleUpdateCardState, mergeUpdateStatus, summarizeUpdaterError } from './update-status-helpers'

describe('mergeUpdateStatus', () => {
  it('preserves release metadata while progress events stream in', () => {
    const available: UpdateStatus = {
      status: 'available',
      version: '0.6.6',
      currentVersion: '0.6.5',
      releaseName: 'Orchestra v0.6.6',
      releaseNotes: 'Fix updater feedback',
      releaseUrl: 'https://github.com/Thiagoxp95/orchestra/releases/tag/v0.6.6',
    }

    expect(mergeUpdateStatus(available, { status: 'downloading', percent: 0 })).toEqual({
      status: 'downloading',
      percent: 0,
      version: '0.6.6',
      currentVersion: '0.6.5',
      releaseName: 'Orchestra v0.6.6',
      releaseNotes: 'Fix updater feedback',
      releaseUrl: 'https://github.com/Thiagoxp95/orchestra/releases/tag/v0.6.6',
    })
  })

  it('preserves the target version and friendly error copy when a download fails', () => {
    const downloading: UpdateStatus = {
      status: 'downloading',
      percent: 42,
      version: '0.6.6',
      currentVersion: '0.6.5',
      releaseUrl: 'https://github.com/Thiagoxp95/orchestra/releases/tag/v0.6.6',
    }

    expect(mergeUpdateStatus(downloading, {
      status: 'error',
      message: 'sha512 checksum mismatch, expected abc, got def',
      detail: 'raw updater error',
    })).toEqual({
      status: 'error',
      message: 'Downloaded update failed integrity verification.',
      detail: 'raw updater error',
      version: '0.6.6',
      currentVersion: '0.6.5',
      releaseUrl: 'https://github.com/Thiagoxp95/orchestra/releases/tag/v0.6.6',
    })
  })
})

describe('summarizeUpdaterError', () => {
  it('explains release metadata mismatches in plain language', () => {
    expect(summarizeUpdaterError('sha512 checksum mismatch, expected abc, got def')).toBe(
      'Downloaded update failed integrity verification.'
    )
  })

  it('falls back to the raw message when it is already user-facing', () => {
    expect(summarizeUpdaterError('Network timeout while downloading update')).toBe(
      'Network timeout while downloading update'
    )
  })
})

describe('getVisibleUpdateCardState', () => {
  it('hides dismissed releases until a newer version arrives', () => {
    expect(getVisibleUpdateCardState({
      status: {
        status: 'available',
        version: '0.6.6',
      },
      dismissedVersion: '0.6.6',
    })).toBeNull()

    expect(getVisibleUpdateCardState({
      status: {
        status: 'available',
        version: '0.6.7',
      },
      dismissedVersion: '0.6.6',
    })).toEqual({
      status: 'available',
      version: '0.6.7',
    })
  })
})
