// Presentation geometry, never written to the team file (§15.6): the Workflow canvas's two
// permanent docked anchors, and where a run's Details places the agents it lists — a seeded
// placement for helpers a run reveals that the document has never heard of, and a replay's own
// layout. Agent positions on the canvas come from `doc.nodes`.

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
  outputW: 340,
  outputH: 150,
  /** A schedule keeps the dock column, above the Prompt, so neither card hides the other. */
  scheduleOffsetY: -132,
  /** Helpers a run reveals are seeded below the entrypoint, never on top of it. */
  helperOffsetY: 300,
} as const

export interface Point { x: number; y: number }

/**
 * Lay out an archived run on its own, without changing the saved design. Historical evidence can
 * mention a lead that is no longer in the current team file; in that case the old lead belongs at
 * the head of the execution spine, not in the helper shelf under today's entrypoint. The
 * synthetic bridge is layout-only — it never claims that a delegation was observed.
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

export interface DockAnchors {
  /** Left of the entrypoint. */
  prompt: Point
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
    output: { x: terminal.x + DOCK.gap, y: terminal.y },
    schedule: { x: entry.x - DOCK.gap, y: entry.y + DOCK.scheduleOffsetY },
  }
}

/**
 * Where to put agents a run revealed that the document has no node for.
 *
 * §15.2.6: team mode has no configured order, so run-time helpers are placed by the existing
 * seeded auto-layout around the entrypoint. These positions are view state — node positions are
 * not part of the team file at all (docs/CANVAS_SPEC.md §7.3).
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
