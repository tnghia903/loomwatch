// The OpenRouter key and the model list, as the daemon serves them (`crates/loomwatch-backend/src/ai`).
//
// The key itself never comes back from the daemon: the app sends it once, and afterwards only
// sees what OpenRouter said about it (its short label, what it has spent, a limit if it has one).

/** What the app knows about the OpenRouter connection. */
export interface KeyStatus {
  connected: boolean
  /** OpenRouter's short form of the key, such as `sk-or-v1-au7...890`. */
  label?: string
  /** Dollars this key has spent. */
  spent?: number
  /** Dollars this key has spent this month (UTC), as OpenRouter counts it. */
  spentThisMonth?: number
  /** Dollars left under the key's own limit, when it has one. */
  limitRemaining?: number
  /** The account has never bought credits, so only free models work. */
  freeTier?: boolean
  checkedAt?: string
  /** Why the last check failed, in plain words. */
  problem?: string
}

/** One model an agent can run on. Prices are dollars per million tokens. */
export interface Model {
  id: string
  name: string
  description?: string
  contextLength: number
  inputPrice: number
  outputPrice: number
  cachedInputPrice?: number
  free: boolean
  reasoning: boolean
  /** Why it is recommended, for the ones that are. */
  note?: string
}

export interface Catalog {
  fetchedAt: string
  defaultModel: string
  recommended: Model[]
  models: Model[]
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(result?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.')
  }
  return result as T
}

export async function fetchKeyStatus(): Promise<KeyStatus> {
  const status = (await call<{ openrouter?: KeyStatus }>('/api/ai')).openrouter
  // An answer that doesn't say is no answer: what everything waiting on a key shows stays unknown.
  if (!status || typeof status !== 'object') throw new Error('LoomWatch didn’t say whether an OpenRouter key is set. Restart LoomWatch and try again.')
  return status
}

/** Checks the key with OpenRouter, then keeps it. A key OpenRouter refuses is never kept. */
export async function saveOpenRouterKey(key: string): Promise<KeyStatus> {
  return (await call<{ openrouter: KeyStatus }>('/api/ai/openrouter', 'PUT', { key })).openrouter
}

export async function recheckOpenRouterKey(): Promise<KeyStatus> {
  return (await call<{ openrouter: KeyStatus }>('/api/ai/openrouter/check', 'POST', {})).openrouter
}

export async function removeOpenRouterKey(): Promise<KeyStatus> {
  return (await call<{ openrouter: KeyStatus }>('/api/ai/openrouter', 'DELETE')).openrouter
}

export async function fetchModels(): Promise<Catalog> {
  return call<Catalog>('/api/models')
}

/** A price per million tokens as the picker shows it: "$0.10", "$4", "Free". */
export function price(perMillion: number): string {
  if (perMillion <= 0) return 'Free'
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`
  return Number.isInteger(perMillion) ? `$${perMillion}` : `$${perMillion.toFixed(2)}`
}

/** The model's name without the vendor's prefix OpenRouter adds ("Anthropic: Claude Opus 5.5"). */
export function shortName(model: Pick<Model, 'name' | 'id'>): string {
  const name = model.name.includes(': ') ? model.name.split(': ').slice(1).join(': ') : model.name
  return name || model.id
}

/** "1M", "262K": a context size in words a newcomer can compare. */
export function contextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`.replace('.0M', 'M')
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return `${tokens}`
}
