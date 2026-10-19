// How agents' models are paid, and the model list, as the daemon serves them
// (`crates/loomwatch-backend/src/ai`): an OpenRouter key, a Claude API key (a Claude Max or Team
// plan's monthly API credit), and the sign-in with ChatGPT (a Plus or Pro plan) (ADR 0073).
//
// No key or token ever comes back from the daemon: the app sends a key once, and afterwards only
// sees what its source said about it.

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

/** One model a Claude key can use, as the key's check listed it. */
export interface ClaudeModel {
  id: string
  name: string
  contextLength: number
  maxOutput: number
  adaptiveThinking: boolean
  efforts?: string[]
}

/** What the app knows about the Claude API key. */
export interface ClaudeStatus {
  connected: boolean
  /** The key's start and end, such as `sk-ant-api03-…x7Qa`. */
  label?: string
  models?: ClaudeModel[]
  checkedAt?: string
  problem?: string
}

/** One model the ChatGPT plan offers. */
export interface ChatGptModel {
  slug: string
  name: string
  contextLength: number
  efforts?: string[]
  priority?: number
}

/** What the app knows about the sign-in with ChatGPT. */
export interface ChatGptStatus {
  /** This copy of LoomWatch offers the ChatGPT plan. */
  available: boolean
  connected: boolean
  email?: string
  /** The person allowed LoomWatch to use their plan, not only to know who they are. */
  planUse: boolean
  models?: ChatGptModel[]
  signedInAt?: string
  problem?: string
}

/** Every way agents' models can be paid, and what the app knows of each. */
export interface AiStatus {
  openrouter: KeyStatus
  anthropic: ClaudeStatus
  chatgpt: ChatGptStatus
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
  /** OpenRouter's models. */
  models: Model[]
  /** The Claude key's models, ids `anthropic:…`, priced as OpenRouter lists them. */
  anthropic?: Model[]
  /** The ChatGPT plan's models, ids `chatgpt:…`, with no price: the plan pays. */
  chatgpt?: Model[]
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

export async function fetchAiStatus(): Promise<AiStatus> {
  const answer = await call<Partial<AiStatus>>('/api/ai')
  // An answer that doesn't say is no answer: what everything waiting on a key shows stays unknown.
  if (!answer.openrouter || typeof answer.openrouter !== 'object') throw new Error('LoomWatch didn’t say whether an OpenRouter key is set. Restart LoomWatch and try again.')
  return {
    openrouter: answer.openrouter,
    // A daemon from before other sources says nothing of them: nothing is connected there.
    anthropic: answer.anthropic ?? { connected: false },
    chatgpt: answer.chatgpt ?? { available: false, connected: false, planUse: false },
  }
}

export async function fetchKeyStatus(): Promise<KeyStatus> {
  return (await fetchAiStatus()).openrouter
}

/** Checks a Claude API key with Anthropic, then keeps it. A key Anthropic refuses is never kept. */
export async function saveClaudeKey(key: string): Promise<ClaudeStatus> {
  return (await call<{ anthropic: ClaudeStatus }>('/api/ai/anthropic', 'PUT', { key })).anthropic
}

export async function recheckClaudeKey(): Promise<ClaudeStatus> {
  return (await call<{ anthropic: ClaudeStatus }>('/api/ai/anthropic/check', 'POST', {})).anthropic
}

export async function removeClaudeKey(): Promise<ClaudeStatus> {
  return (await call<{ anthropic: ClaudeStatus }>('/api/ai/anthropic', 'DELETE')).anthropic
}

/** Starts a sign-in with ChatGPT: the address of OpenAI's page, to open in a new tab. */
export async function startChatGptSignIn(): Promise<string> {
  return (await call<{ url: string }>('/api/ai/chatgpt/sign-in', 'POST', {})).url
}

/** Lists the plan's models again, which also proves the sign-in still works. */
export async function checkChatGpt(): Promise<ChatGptStatus> {
  return (await call<{ chatgpt: ChatGptStatus }>('/api/ai/chatgpt/check', 'POST', {})).chatgpt
}

/** Signs out, revoking the sign-in with OpenAI. `revoked` says whether OpenAI confirmed it. */
export async function signOutChatGpt(): Promise<{ chatgpt: ChatGptStatus; revoked: boolean }> {
  return call<{ chatgpt: ChatGptStatus; revoked: boolean }>('/api/ai/chatgpt', 'DELETE')
}

/** Where the page OpenAI sends the browser back to tells the app how the sign-in went. */
export const AI_CHANNEL = 'loomwatch-ai'
export type SignInOutcome = 'connected' | 'plan_use_off' | 'denied' | 'expired' | 'failed' | 'storage'

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
