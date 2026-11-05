// What the shared PR page (apps/web/src/components/github) gets for '@/lib/sync'
// inside the desktop: the same `api.github.*` names and `useSync().call`, answered
// over IPC by main/github-ipc.ts instead of the phone's sync socket.

export const api = {
  github: new Proxy({} as Record<string, string>, { get: (_target, fn: string) => `github.${fn}` }),
}

const client = {
  call: (name: string, args: Record<string, unknown> = {}): Promise<unknown> => window.electronAPI.githubCall(name, args),
}

export function useSync() {
  return client
}
