import type { UpdateStatus } from './types'

type UpdateCardVisibilityInput = {
  status: UpdateStatus | null
  dismissedVersion: string | null
}

const RELEASE_METADATA_FIELDS = [
  'version',
  'currentVersion',
  'releaseName',
  'releaseNotes',
  'releaseDate',
  'releaseUrl',
] as const satisfies readonly (keyof UpdateStatus)[]

export function summarizeUpdaterError(message?: string): string {
  const raw = message?.trim()
  if (!raw) return 'The update could not be downloaded.'

  const normalized = raw.toLowerCase()

  if (
    normalized.includes('sha512')
    || normalized.includes('checksum')
    || normalized.includes('integrity')
    || normalized.includes('size mismatch')
  ) {
    return 'Downloaded update failed integrity verification.'
  }

  if (normalized.includes('differential') || normalized.includes('blockmap')) {
    return 'Delta update failed. Retry to fetch the full update package.'
  }

  return raw
}

export function mergeUpdateStatus(previous: UpdateStatus | null, incoming: UpdateStatus): UpdateStatus {
  const preserved = Object.fromEntries(
    RELEASE_METADATA_FIELDS.flatMap((field) => {
      const value = previous?.[field]
      return value === undefined ? [] : [[field, value]]
    })
  ) as Partial<UpdateStatus>

  const next: UpdateStatus = {
    ...preserved,
    ...incoming,
  }

  if (incoming.status === 'error') {
    const detail = incoming.detail ?? incoming.message ?? previous?.detail ?? previous?.message
    next.message = summarizeUpdaterError(incoming.message ?? incoming.detail ?? previous?.message)
    if (detail) {
      next.detail = detail
    }
    return next
  }

  delete next.detail
  if (incoming.message === undefined) {
    delete next.message
  }

  return next
}

export function getVisibleUpdateCardState({ status, dismissedVersion }: UpdateCardVisibilityInput): UpdateStatus | null {
  if (!status) return null
  if (!dismissedVersion || !status.version) return status
  if (status.version !== dismissedVersion) return status
  return status.status === 'downloading' ? status : null
}
