const actualToProcessSessionId = new Map<string, string>()
const processToActualSessionId = new Map<string, string>()

export function registerAgentSessionAlias(actualSessionId: string, processSessionId?: string | null): void {
  const normalizedProcessSessionId = processSessionId?.trim() || actualSessionId
  const previousProcessSessionId = actualToProcessSessionId.get(actualSessionId)
  if (previousProcessSessionId && previousProcessSessionId !== normalizedProcessSessionId) {
    processToActualSessionId.delete(previousProcessSessionId)
  }

  const previousActualSessionId = processToActualSessionId.get(normalizedProcessSessionId)
  if (previousActualSessionId && previousActualSessionId !== actualSessionId) {
    actualToProcessSessionId.delete(previousActualSessionId)
  }

  actualToProcessSessionId.set(actualSessionId, normalizedProcessSessionId)
  processToActualSessionId.set(normalizedProcessSessionId, actualSessionId)
}

export function resolveAgentProcessSessionId(actualSessionId: string): string {
  return actualToProcessSessionId.get(actualSessionId) ?? actualSessionId
}

export function resolveAgentActualSessionId(processSessionId: string): string {
  return processToActualSessionId.get(processSessionId) ?? processSessionId
}

export function clearAgentSessionAlias(actualSessionId: string): void {
  const processSessionId = actualToProcessSessionId.get(actualSessionId)
  if (processSessionId) {
    processToActualSessionId.delete(processSessionId)
  }
  actualToProcessSessionId.delete(actualSessionId)
}

export function clearAllAgentSessionAliases(): void {
  actualToProcessSessionId.clear()
  processToActualSessionId.clear()
}
