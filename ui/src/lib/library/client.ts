import { daemonFetch } from '../daemonFetch'

export interface DetectedCapability {
  id: string
  name: string
  source: string
  detail: string
  status: 'Ready' | 'Compatible' | 'Local only'
  /**
   * Present only on a knowledge source that is team memory: another team on this daemon, or an
   * imported pack. Mirrors `backend::capabilities::MemorySourceRef`.
   *
   * The ids are carried rather than inferred from the row's name, because wiring this card writes
   * a `memory.inherits` entry and the entry needs them verbatim. Recovering them by splitting
   * `"<Team name> · memory"` would put a display name into executable configuration.
   */
  memory?: MemorySourceRef
}

export interface MemorySourceRef {
  /** The team id for `memory.inherits[].team`. Exactly one of this and `pack` is set. */
  team?: string
  /** The pack folder for `memory.inherits[].pack`, relative to the teams root. */
  pack?: string
  brief: number
  /**
   * Kept notes, when the source states them. A pack's manifest counts its own; a live team's
   * notes are rows the filesystem scan has no pool to count, so a team reports nothing rather
   * than claiming zero.
   */
  kept?: number
}

export interface CapabilityInventory {
  skills: DetectedCapability[]
  tools: DetectedCapability[]
  sources: DetectedCapability[]
}

export interface CapabilityDefinition {
  source: string
  path: string
  content: string
}

export interface CapabilityDetails {
  id: string
  kind: 'skill' | 'tool' | 'knowledge'
  definitions: CapabilityDefinition[]
  /**
   * What this skill assumes about the harness running it, and the route it takes on each one.
   * Mirrors `backend::capabilities::SkillPortabilityReport`. Absent for a tool, a knowledge
   * source, a skill with no readable definition, and any daemon older than ADR 0021.
   */
  portability?: SkillPortability
}

/** How one skill reaches one agent (`backend::skill_routing::SkillRoute`). */
export type SkillRoute = 'native' | 'inline' | 'blocked'

export interface SkillPortability {
  /** `artifact`, `behavior`, or `portable`. */
  kind: string
  /** The harness assumptions found in the skill's text, as words the operator can read. */
  needs: string[]
  evidence: { need: string; line: string }[]
  /**
   * Harness id to route. Computed by the daemon, not re-derived here: the rule lives in
   * `skill_routing::route`, and a second copy of it in TypeScript would be a second rule that
   * could disagree with the one the run actually applies.
   */
  routes: Record<string, SkillRoute>
}

/** The daemon embeds this UI at build time (`spa.rs`), so a long-running `loomwatchd` can serve a
 * newer bundle's requests from an older binary. An endpoint that binary lacks falls through to the
 * SPA route and answers `200 text/html`, which used to surface as `Unexpected token '<'` — or, on
 * an even older daemon, a bare 404. Both really mean "restart the daemon". */
/** True only when the SPA fallback answered instead of the API. An answer with no content-type at
 * all is left alone — `json()` will report whatever is really wrong with it. */
export function servesHtml(response: Response): boolean {
  return response.headers?.get('content-type')?.includes('html') ?? false
}

export const STALE_DAEMON = 'This daemon is older than the app it is serving. Restart loomwatchd to pick up the local capability scan.'
export const STALE_DETAILS_DAEMON = 'This daemon is older than the app it is serving. Restart loomwatchd to view capability details.'
/** A current daemon answering 404 with its own error: the capability is not on this machine now. */
export const CAPABILITY_NOT_FOUND = 'LoomWatch can’t find this on this computer any more. It may have been uninstalled or renamed; search the Library for it.'

export async function fetchCapabilities(): Promise<CapabilityInventory> {
  const response = await daemonFetch('/api/capabilities')
  if (response.status === 404) throw new Error(STALE_DAEMON)
  if (!response.ok) throw new Error(response.statusText || 'Capability scan failed')
  if (servesHtml(response)) throw new Error(STALE_DAEMON)
  return (await response.json()) as CapabilityInventory
}

/** Load a selected capability's local definition. Skill instructions are intentionally fetched
 * on demand rather than included in the inventory response. */
export async function fetchCapabilityDetails(id: string): Promise<CapabilityDetails> {
  const response = await daemonFetch(`/api/capabilities/${encodeURIComponent(id)}`)
  if (servesHtml(response)) throw new Error(STALE_DETAILS_DAEMON)
  if (response.status === 404) {
    // A daemon with this route answers an unknown id with `unknown capability "<id>"`; one that
    // predates the route falls through to `API route not found` (`spa.rs`). Only the second is stale.
    let message = ''
    try { message = String(((await response.json()) as { error?: unknown }).error ?? '') } catch { /* not JSON */ }
    throw new Error(message.startsWith('unknown capability') ? CAPABILITY_NOT_FOUND : STALE_DETAILS_DAEMON)
  }
  if (!response.ok) {
    let message = response.statusText || 'Capability details could not be loaded'
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch { /* keep the status text when the response is not JSON */ }
    throw new Error(message)
  }
  return (await response.json()) as CapabilityDetails
}
