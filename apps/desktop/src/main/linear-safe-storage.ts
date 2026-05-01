import { safeStorage, type IpcMain } from 'electron'

export function encryptStringForStorage(rawValue: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(rawValue, 'utf-8').toString('base64')
  }
  return safeStorage.encryptString(rawValue).toString('base64')
}

export function decryptStringFromStorage(encryptedValue: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(encryptedValue, 'base64').toString('utf-8')
  }
  return safeStorage.decryptString(Buffer.from(encryptedValue, 'base64'))
}

export function registerLinearSafeStorage(ipc: IpcMain): void {
  ipc.handle('linear:encrypt-key', (_event, rawKey: string): string => {
    return encryptStringForStorage(rawKey)
  })

  ipc.handle('linear:decrypt-key', (_event, encryptedKey: string): string => {
    return decryptStringFromStorage(encryptedKey)
  })

  ipc.handle('openrouter:encrypt-key', (_event, rawKey: string): string => {
    return encryptStringForStorage(rawKey)
  })

  ipc.handle('openrouter:decrypt-key', (_event, encryptedKey: string): string => {
    return decryptStringFromStorage(encryptedKey)
  })
}
