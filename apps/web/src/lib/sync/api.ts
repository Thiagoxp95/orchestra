// lib/sync/api.ts
//
// Function names as values: `api.remote.getRemoteState` is the string
// `"remote.getRemoteState"`. Call sites keep reading like property access
// instead of scattering string literals, and a typo still shows up as a
// server-side "Unknown query" rather than silently doing nothing.

export type FunctionName = string

type Module = Record<string, FunctionName>

/** `api.<module>.<function>` → `"<module>.<function>"`. */
export const api: Record<string, Module> = new Proxy(
  {},
  {
    get: (_target, moduleName: string) =>
      new Proxy(
        {},
        { get: (_m, functionName: string) => `${moduleName}.${functionName}` },
      ),
  },
) as Record<string, Module>
