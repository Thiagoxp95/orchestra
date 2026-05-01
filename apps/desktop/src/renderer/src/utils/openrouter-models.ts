export interface OpenRouterModelOption {
  id: string
  name: string
}

export function normalizeOpenRouterModels(payload: unknown): OpenRouterModelOption[] {
  const data = payload && typeof payload === 'object'
    ? (payload as { data?: unknown }).data
    : undefined

  if (!Array.isArray(data)) return []

  return data
    .filter((model): model is { id: string; name?: unknown } => (
      model != null
      && typeof model === 'object'
      && typeof (model as { id?: unknown }).id === 'string'
    ))
    .map((model) => ({
      id: model.id,
      name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function filterOpenRouterModels(
  models: OpenRouterModelOption[],
  query: string,
): OpenRouterModelOption[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return models

  return models.filter((model) => (
    model.id.toLowerCase().includes(normalizedQuery)
    || model.name.toLowerCase().includes(normalizedQuery)
  ))
}
