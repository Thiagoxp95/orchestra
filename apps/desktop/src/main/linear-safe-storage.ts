import { safeStorage, type IpcMain } from 'electron'

export function registerLinearSafeStorage(ipc: IpcMain): void {
  ipc.handle('linear:encrypt-key', (_event, rawKey: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(rawKey, 'utf-8').toString('base64')
    }
    return safeStorage.encryptString(rawKey).toString('base64')
  })

  ipc.handle('linear:decrypt-key', (_event, encryptedKey: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encryptedKey, 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
  })
}
