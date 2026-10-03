// Planned capability wiring: which skills, connectors and knowledge sources the operator wants an
// agent to be able to reach, and where those cards sit. docs/TNG122_FREEFORM_CAPABILITY_COMPOSER.md
// §8.2 keeps this OUT of team.schema.yaml until an ADR says otherwise, so it lives in a versioned
// `<team>.layout.json` sidecar that the daemon stores but never executes.
//
// §5: this is editable *intent*. It never claims a capability ran, and §8.4: naming a capability
// here grants no access — the harness's own authorization still decides.

/**
 * Version 2 (ADR 0016) adds two fields, both additive: a knowledge card may carry the `memory` it
 * stands for, and the sidecar carries agent positions. A version-1 file is read and stamped
 * forward by `migrateLayout` — there is nothing to convert, only two absent fields.
 */
export const LAYOUT_VERSION = 2
/** The oldest version this client reads. Anything between is upgraded, never refused. */
export const OLDEST_READABLE_LAYOUT_VERSION = 1

export type CapabilityKind = 'skill' | 'tool' | 'knowledge'

/** §4's typed connection matrix: exactly one relationship word per target kind. */
export const RELATION: Record<CapabilityKind, string> = {
  skill: 'uses skill',
  tool: 'invokes',
  knowledge: 'reads',
}

export const KIND_LABEL: Record<CapabilityKind, string> = {
  skill: 'Skill',
  tool: 'Tool or connector',
  knowledge: 'Knowledge source',
}

/**
 * Which memory a knowledge card stands for (`composer::MemoryRef`). Exactly one of the two.
 *
 * The card carries it because the card is what gets wired: drawing an edge from an agent to this
 * card writes `memory.inherits[]` in the **team file**, and that entry needs the team id or the
 * pack path verbatim. Recovering them by splitting the display name would write a display name
 * into executable configuration.
 */
export interface MemoryRef {
  team?: string
  pack?: string
}

export interface CapabilityNodeConfig {
  id: string
  kind: CapabilityKind
  name: string
  /** Provenance exactly as the Library showed it, e.g. `Codex · sales`. Display only. */
  source: string
  position: { x: number; y: number }
  /** Set on a knowledge card that is team memory. Absent on every other card. */
  memory?: MemoryRef
  /**
   * Set on a knowledge card that is a folder or file the operator chose (ADR 0042): the `path` its
   * agents' knowledge entries carry. One card per path, however many agents read it.
   */
  path?: string
}

export interface CapabilityEdgeConfig {
  /** Agent id in the team file — only an agent may reach a capability (§4). */
  from: string
  /** Capability node id in this layout. */
  to: string
}

export interface ComposerLayout {
  output?: { name: string; format: string }
  version: number
  nodes: CapabilityNodeConfig[]
  edges: CapabilityEdgeConfig[]
  /**
   * Where the operator put each **agent** card, by agent id.
   *
   * docs/CANVAS_SPEC.md §7.3 flagged this and did not decide it; ADR 0016 takes option A. It is
   * the rule ADR 0011/0012 already drew — positions in the sidecar, contract in the team file — so
   * a drag writes here and never dirties the team YAML. An absent entry is a normal state: the
   * canvas falls back to the deterministic auto-layout seeded by the team id.
   */
  agents: Record<string, { x: number; y: number }>
}

export const EMPTY_LAYOUT: ComposerLayout = { version: LAYOUT_VERSION, nodes: [], edges: [], agents: {} }

/**
 * Read a sidecar of any supported version as the current one, or `null` for one this build does
 * not know.
 *
 * A version-1 file needs no conversion — version 2 only adds fields — so this fills the defaults
 * and stamps the version. `null` is what makes a *future* sidecar show as unreadable rather than
 * being silently overwritten with an empty canvas.
 */
export function migrateLayout(raw: ComposerLayout): ComposerLayout | null {
  if (raw.version < OLDEST_READABLE_LAYOUT_VERSION || raw.version > LAYOUT_VERSION) return null
  return {
    version: LAYOUT_VERSION,
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
    agents: raw.agents ?? {},
    ...(raw.output ? { output: raw.output } : {}),
  }
}

/** `skill` + `notebooklm` → `skill:notebooklm`. Stable, so dropping the same row twice is one node. */
export function capabilityNodeId(kind: CapabilityKind, name: string): string {
  return `${kind}:${name.trim().toLowerCase().replace(/\s+/g, '-')}`
}

/** A chosen path as cards compare it: trimmed, without a trailing slash. */
export function sourcePath(path: string): string {
  const trimmed = path.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

/**
 * The card for a folder or file is keyed by its path, not its label (ADR 0042): two agents may
 * label the same folder differently, and two folders may share a name.
 */
export function sourceCardId(path: string): string {
  return `knowledge@${sourcePath(path)}`
}

/** The card id a payload or card gets: by path for a chosen folder or file, by kind and name otherwise. */
export function cardId(card: Pick<CapabilityNodeConfig, 'kind' | 'name' | 'path'>): string {
  return card.kind === 'knowledge' && card.path ? sourceCardId(card.path) : capabilityNodeId(card.kind, card.name)
}

/** The payload the Library puts on `dataTransfer`, and what a click-to-place sends. */
export interface CapabilityDragPayload {
  kind: CapabilityKind
  name: string
  source: string
  /**
   * For a knowledge card that is team memory: the team id or pack folder wiring it will write
   * into `memory.inherits`.
   *
   * On the drag payload because the drop is where the card is created, and the card has to know
   * which memory it stands for before anyone connects it to an agent.
   */
  memory?: { team?: string; pack?: string }
  /** For a folder or file card: the path its agents' knowledge entries will carry (ADR 0042). */
  path?: string
}

/**
 * §4: "capabilities attach to agents rather than to each other". Returns the refusal the operator
 * should read, or `null` when the connection is allowed.
 */
export function refuseCapabilityEdge(
  from: { id: string; isAgent: boolean },
  to: { id: string; isAgent: boolean; kind?: CapabilityKind },
  existing: readonly CapabilityEdgeConfig[],
): string | null {
  if (!from.isAgent) {
    return 'Only an agent can use a capability. Start the connection at an agent.'
  }
  if (to.isAgent) {
    return null
  }
  if (existing.some((edge) => edge.from === from.id && edge.to === to.id)) {
    return 'That agent already reaches this capability.'
  }
  return null
}

/**
 * The `agents[].capabilities` kind a card is wired as, or `null` when it is not wired through
 * them. Skills since ADR 0012, tools since ADR 0029, and a folder or file since ADR 0042. A memory
 * card is wired through `memory.inherits` instead (ADR 0016), and a knowledge card with no path is
 * one the Library placed before ADR 0036: its name alone points at nothing.
 */
export function teamFileKind(card: Pick<CapabilityNodeConfig, 'kind' | 'memory' | 'path'>): CapabilityKind | null {
  if (card.kind !== 'knowledge') return card.kind
  return card.path && !card.memory ? 'knowledge' : null
}

/**
 * Whether a team-file capability entry is this card. A skill or tool by kind and name both (they
 * may share a name); a folder or file by its path, whatever each agent labels it.
 */
export function capabilityIsCard(
  capability: { kind: CapabilityKind; name: string; path?: string },
  card: Pick<CapabilityNodeConfig, 'kind' | 'name' | 'memory' | 'path'>,
): boolean {
  const kind = teamFileKind(card)
  if (kind !== capability.kind) return false
  if (kind === 'knowledge') return Boolean(capability.path && card.path && sourcePath(capability.path) === sourcePath(card.path))
  return capability.name === card.name
}

/**
 * The team-file entry that connects an agent to this card, or `null` for a card that is not wired
 * through `agents[].capabilities`. A folder or file keeps its path and takes a label no other
 * knowledge of that agent has, as Add folder… and Add file… do.
 */
export function capabilityForCard(
  card: Pick<CapabilityNodeConfig, 'kind' | 'name' | 'memory' | 'path'>,
  agentCapabilities: readonly { kind: CapabilityKind; name: string }[],
): { kind: CapabilityKind; name: string; path?: string } | null {
  const kind = teamFileKind(card)
  if (!kind) return null
  if (kind !== 'knowledge' || !card.path) return { kind, name: card.name }
  const taken = new Set(agentCapabilities.filter((capability) => capability.kind === 'knowledge').map((capability) => capability.name))
  return { kind, name: uniqueLabel(card.name, taken), path: card.path }
}

/** `report.pdf`, or `report.pdf (2)` when `taken` already has that name; the label is then taken. */
export function uniqueLabel(name: string, taken: Set<string>): string {
  let label = name
  for (let counter = 2; taken.has(label); counter += 1) label = `${name} (${counter})`
  taken.add(label)
  return label
}

/** Rendered size of a capability card (`.capability-node`), used to keep placements apart. */
export const CAPABILITY_CARD = { width: 276, height: 72, gap: 24 }

/**
 * `offsetCollision` in team-file/layout.ts only nudges an *exact* coordinate match by 24 px, which
 * is right for a dropped agent but leaves click-placed cards — which all arrive at the viewport
 * centre — stacked on top of each other. This clears the whole card footprint instead.
 */
export function freeCapabilitySlot(
  preferred: { x: number; y: number },
  occupied: readonly { x: number; y: number }[],
): { x: number; y: number } {
  const step = CAPABILITY_CARD.height + CAPABILITY_CARD.gap
  const overlaps = (candidate: { x: number; y: number }) => occupied.some((other) =>
    Math.abs(other.x - candidate.x) < CAPABILITY_CARD.width + CAPABILITY_CARD.gap &&
    Math.abs(other.y - candidate.y) < step)
  let candidate = preferred
  // Six rows, then start a fresh column rather than walking off the bottom of the canvas.
  for (let attempt = 0; attempt < 48 && overlaps(candidate); attempt += 1) {
    candidate = attempt % 6 === 5
      ? { x: candidate.x + CAPABILITY_CARD.width + CAPABILITY_CARD.gap, y: preferred.y }
      : { x: candidate.x, y: candidate.y + step }
  }
  return candidate
}
