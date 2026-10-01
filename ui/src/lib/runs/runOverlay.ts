// One canvas — TNG89_INTERACTION.md §15, decision 6 of docs/TEAM_MEMORY.md.
//
//   > The configured graph never moves; a run is drawn onto it.
//
// This module replaces `storyLayout`, which computed a causal column and moved every agent card
// the operator had placed. There is no runtime layout any more: agent positions come from
// `doc.nodes` in every state. What is left is *presentation geometry* — the two permanent docked
// anchors, the fan of one agent's evidence, and a seeded placement for helpers a run reveals that
// the document has never heard of. None of it is written to the team file (§15.6).

import { seededLayout } from '../team-file/layout'
import { organizePipeline, type LayoutCard, type LayoutLink, type Positions } from '../composer-layout/organize'

export const DOCK = {
  /**
   * Enough room for the 360px Prompt plus a visible edge gutter. The old 340px
   * offset put its right edge inside the entrypoint card.
   */
  gap: 460,
  promptW: 360,
  promptH: 112,
  runW: 230,
  runH: 78,
  outputW: 340,
  outputH: 150,
  /** The `Run NN` attempt card sits under the Prompt, small (§15.2.2 / §12.2 keeps it visible). */
  // The prompt grows when a preserved request wraps. Leave a real card gutter rather than
  // assuming its 112 px minimum height is its final measured height.
  runOffsetY: 152,
  /** A schedule keeps the dock column, above the Prompt, so neither card hides the other. */
  scheduleOffsetY: -132,
  evidenceW: 190,
  /** The rendered height of an evidence card (`.activity-ent`: order, name, status, detail). */
  evidenceH: 90,
  /**
   * The fan opens below its agent as one column, left-aligned with the agent and below anything
   * already hanging from it, so the agent's resources and its evidence read as one list — which
   * `lib/canvas/ports.ts` draws as a tree off a single trunk.
   */
  fanCols: 1,
  fanGapX: 208,
  fanGapY: 104,
  fanOffsetX: 0,
  fanOffsetY: 138,
  /** Helpers a run reveals are seeded below the entrypoint, never on top of it. */
  helperOffsetY: 300,
  /**
   * A real run produces dozens of events. Even fanned one agent at a time, the cards past two
   * columns × four rows fold into a `+N more` card that opens the provenance panel — TNG89 §4's
   * "one hop at a time", and §15.3's "a fold is a disclosure with a count".
   */
  maxVisible: 8,
} as const

export interface Point { x: number; y: number }

/**
 * Give an archived run the same visual grammar as the Build canvas without changing the saved
 * design. Historical evidence can mention a lead that is no longer in the current team file; in
 * that case the old lead belongs at the head of the execution spine, not in the helper shelf under
 * today's entrypoint. The synthetic bridge is layout-only — it never claims that a delegation was
 * observed and is not rendered as an edge.
 */
export function historicalRunPositions(
  agents: readonly LayoutCard[],
  sequence: readonly LayoutLink[],
  resources: readonly LayoutCard[],
  wiring: readonly LayoutLink[],
  historicalLead: string | null,
  configuredEntrypoint: string | null,
): Positions {
  const ids = new Set(agents.map(({ id }) => id))
  const links = [...sequence]
  if (
    historicalLead && configuredEntrypoint
    && historicalLead !== configuredEntrypoint
    && ids.has(historicalLead) && ids.has(configuredEntrypoint)
    && !links.some(({ from, to }) => from === historicalLead && to === configuredEntrypoint)
  ) links.push({ from: historicalLead, to: configuredEntrypoint })
  return organizePipeline(agents, links, resources, wiring)
}

/** Which evidence ids an agent shows as cards, and how many fold into the overflow card. */
export function visibleEvidence(ids: readonly string[]): { shown: string[]; hidden: number } {
  if (ids.length <= DOCK.maxVisible) return { shown: [...ids], hidden: 0 }
  return { shown: ids.slice(0, DOCK.maxVisible - 1), hidden: ids.length - (DOCK.maxVisible - 1) }
}

export interface DockAnchors {
  /** Left of the entrypoint. */
  prompt: Point
  /** Under the Prompt. */
  run: Point
  /** Right of the terminal stage (pipeline) or of the entrypoint (team mode). */
  output: Point
  /** Above the Prompt, when the team has a schedule. */
  schedule: Point
}

/**
 * The two permanent anchors, computed from the document's own positions.
 *
 * `entry` is the entrypoint's position and `terminal` the last stage's; in team mode, which has no
 * configured order, both are the entrypoint's. Docking — rather than a computed column — is what
 * guarantees acceptance rows 23/24 and 42: Prompt first, Output last.
 */
export function dockAnchors(entry: Point, terminal: Point): DockAnchors {
  return {
    prompt: { x: entry.x - DOCK.gap, y: entry.y },
    run: { x: entry.x - DOCK.gap, y: entry.y + DOCK.runOffsetY },
    output: { x: terminal.x + DOCK.gap, y: terminal.y },
    schedule: { x: entry.x - DOCK.gap, y: entry.y + DOCK.scheduleOffsetY },
  }
}

export interface Fan {
  shown: Record<string, Point>
  /** The `+N more` card's slot, when this agent's evidence overflows. */
  more: (Point & { hidden: number }) | null
}

/**
 * One agent's evidence, fanned out below its card.
 *
 * Positions are pure view state: they are never written to the document and they never displace a
 * configured node (§15.2.3). Only one agent is ever fanned, so what React Flow renders is capped
 * at the agents plus one cluster instead of every event card.
 */
export function fanEvidence(anchor: Point, ids: readonly string[], clearance: number = DOCK.fanOffsetY): Fan {
  const { shown, hidden } = visibleEvidence(ids)
  // `clearance` starts the comb below whatever already hangs from the agent (its resources).
  const top = Math.max(DOCK.fanOffsetY, clearance)
  const slot = (index: number): Point => ({
    x: anchor.x + DOCK.fanOffsetX + (index % DOCK.fanCols) * DOCK.fanGapX,
    y: anchor.y + top + Math.floor(index / DOCK.fanCols) * DOCK.fanGapY,
  })
  return {
    shown: Object.fromEntries(shown.map((id, index) => [id, slot(index)])),
    more: hidden > 0 ? { ...slot(shown.length), hidden } : null,
  }
}

/**
 * Where to put agents a run revealed that the document has no node for.
 *
 * §15.2.6: team mode has no configured order, so run-time helpers are placed by the existing
 * seeded auto-layout around the entrypoint. These positions are view state until the operator
 * drags one — and there is nowhere to save them to, because node positions are not part of the
 * team file at all (docs/CANVAS_SPEC.md §7.3). See the ledger note in docs/TEAM_MEMORY.md.
 */
export function helperPositions(helperIds: readonly string[], anchor: Point): Record<string, Point> {
  if (helperIds.length === 0) return {}
  const seeded = seededLayout([...helperIds])
  return Object.fromEntries(
    Object.entries(seeded).map(([id, point]) => [id, { x: anchor.x + point.x, y: anchor.y + DOCK.helperOffsetY + point.y }]),
  )
}

/** Causal agent order: pipeline order when configured, else lead first then first appearance. */
export function causalOrder(pipeline: readonly string[], projected: readonly { id: string; firstSeq: number }[], lead: string | null): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); order.push(id) } }
  if (lead) push(lead)
  pipeline.forEach(push)
  ;[...projected].sort((a, b) => a.firstSeq - b.firstSeq).forEach((agent) => push(agent.id))
  return order
}
