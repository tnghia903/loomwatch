// Configured-edge draw/refusal rules (docs/CANVAS_SPEC.md §6.6). Pure and framework-free so
// the refusal wording is testable without a React Flow connection event.

export interface EdgeEndpoints {
  from: string
  to: string
}

export interface EdgeRefusal {
  message: string
  /** Set only for the "edge into the entrypoint" refusal: the node the popover offers to promote. */
  promote?: string
}

function reachable(edges: readonly EdgeEndpoints[], start: string, target: string, visited: Set<string>): boolean {
  if (start === target) {
    return true
  }
  if (visited.has(start)) {
    return false
  }
  visited.add(start)
  return edges.some((edge) => edge.from === start && reachable(edges, edge.to, target, visited))
}

/** Adding `from -> to` closes a loop if `to` can already reach `from`. */
export function wouldCreateCycle(edges: readonly EdgeEndpoints[], from: string, to: string): boolean {
  return reachable(edges, to, from, new Set())
}

/**
 * Validates a configured edge a user just drew, against TEAM_CONFIG.md's semantic rules as
 * surfaced in §6.6's refusal table. Returns `null` when the edge is allowed.
 */
export function validateConfiguredEdge(
  existing: readonly EdgeEndpoints[],
  from: string,
  to: string,
  entrypointId: string | null,
): EdgeRefusal | null {
  if (from === to) {
    return { message: "An agent can't follow itself." }
  }
  if (existing.some((edge) => edge.from === from && edge.to === to)) {
    return { message: 'These are already connected.' }
  }
  if (wouldCreateCycle(existing, from, to)) {
    return { message: `That would make a loop: ${from} → ${to} → ${from}. Pipelines run in one direction.` }
  }
  if (entrypointId !== null && to === entrypointId) {
    return { message: `\`${to}\` is the entrypoint, so it can't have an incoming step.`, promote: from }
  }
  return null
}
