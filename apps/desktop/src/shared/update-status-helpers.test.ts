import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from './types'
import {
  getVisibleUpdateCardState,
  isNetworkUpdaterError,
  mergeUpdateStatus,
  summarizeUpdaterError,
} from './update-status-helpers'

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
        status: 'downloaded',
        version: '0.6.6',
      },
      dismissedVersion: '0.6.6',
    })).toBeNull()

    expect(getVisibleUpdateCardState({
      status: {
        status: 'downloaded',
        version: '0.6.7',
      },
      dismissedVersion: '0.6.6',
    })).toEqual({
      status: 'downloaded',
      version: '0.6.7',
    })
  })

  it('hides available and downloading states so the card stays silent during auto-download', () => {
    expect(getVisibleUpdateCardState({
      status: { status: 'available', version: '0.6.7' },
      dismissedVersion: null,
    })).toBeNull()

    expect(getVisibleUpdateCardState({
      status: { status: 'downloading', percent: 42, version: '0.6.7' },
      dismissedVersion: null,
    })).toBeNull()
  })

  it('shows downloaded and error states', () => {
    expect(getVisibleUpdateCardState({
      status: { status: 'downloaded', version: '0.6.7' },
      dismissedVersion: null,
    })).toEqual({ status: 'downloaded', version: '0.6.7' })

    expect(getVisibleUpdateCardState({
      status: { status: 'error', message: 'Downloaded update failed integrity verification.' },
      dismissedVersion: null,
    })).toEqual({ status: 'error', message: 'Downloaded update failed integrity verification.' })
  })

  it('hides checking and not-available terminal states', () => {
    expect(getVisibleUpdateCardState({
      status: { status: 'checking' },
      dismissedVersion: null,
    })).toBeNull()

    expect(getVisibleUpdateCardState({
      status: { status: 'not-available' },
      dismissedVersion: null,
    })).toBeNull()
  })
})

describe('isNetworkUpdaterError', () => {
  it.each([
    ['net::ERR_INTERNET_DISCONNECTED'],
    ['net::ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_NETWORK_CHANGED'],
    ['getaddrinfo ENOTFOUND github-releases.githubusercontent.com'],
    ['connect ECONNREFUSED 140.82.114.4:443'],
    ['connect ETIMEDOUT 140.82.114.4:443'],
    ['ENETUNREACH 140.82.114.4:443'],
    ['EAI_AGAIN api.github.com'],
    ['socket hang up'],
    ['request to https://github.com/.../latest-mac.yml failed, reason: read ECONNRESET'],
  ])('classifies %s as a network error', (message) => {
    expect(isNetworkUpdaterError(message)).toBe(true)
  })

  it.each([
    ['sha512 checksum mismatch, expected abc, got def'],
    ['Downloaded update failed integrity verification.'],
    ['Delta update failed. Retry to fetch the full update package.'],
    ['Cannot find latest-mac.yml in the release'],
    ['Could not get code signature for running application'],
    ['Error: App is damaged'],
  ])('does not classify %s as a network error', (message) => {
    expect(isNetworkUpdaterError(message)).toBe(false)
  })

  it('returns false for empty or undefined messages', () => {
    expect(isNetworkUpdaterError('')).toBe(false)
    expect(isNetworkUpdaterError(undefined)).toBe(false)
  })
})
