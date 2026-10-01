// docs/CANVAS_SPEC.md §8.2 step numbers + TEAM_CONFIG.md's pipeline_order(): a topological
// order over the configured edges, entrypoint first (it is validated elsewhere to have no
// incoming edge, so it is always a valid start). Pure and framework-free like edgeRules.ts.

export interface EdgeEndpoints {
  from: string
  to: string
}

export interface PipelineStep {
  id: string
  /** 1-indexed position in pipeline_order(). */
  step: number
  /** Predecessor ids, in the order their edges are declared, when there is more than one. */
  joinFrom: string[]
}

/**
 * The one terminal that a run starting at `entrypoint` can actually reach.
 *
 * `pipelineOrder` deliberately appends disconnected nodes so the UI can still list and inspect
 * an invalid draft. That presentation order must not decide who produces the Output, though: a
 * freshly dropped orphan is not part of the configured execution path. Branches are accepted only
 * when they converge on one reachable terminal; otherwise there is no unambiguous responder.
 */
export function pipelineTerminal(
  nodeIds: readonly string[],
  edges: readonly EdgeEndpoints[],
  entrypoint: string | null,
): string | null {
  if (entrypoint === null || !nodeIds.includes(entrypoint)) return null

  const nodes = new Set(nodeIds)
  const successors = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) successors.get(edge.from)?.push(edge.to)
  }

  const reachable = new Set<string>()
  const pending = [entrypoint]
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    pending.push(...(successors.get(id) ?? []))
  }

  const terminals = [...reachable].filter((id) => (successors.get(id) ?? []).length === 0)
  return terminals.length === 1 ? terminals[0] : null
}

/**
 * Empty when `edges` is empty — team mode has no step order to show. Nodes unreachable from
 * the entrypoint (no path in, e.g. a freshly dropped orphan) are appended last in the order
 * they were passed, since TEAM_CONFIG.md does not define their rank.
 */
export function pipelineOrder(
  nodeIds: readonly string[],
  edges: readonly EdgeEndpoints[],
  entrypoint: string | null,
): PipelineStep[] {
  if (edges.length === 0) {
    return []
  }

  const predecessors = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  const successors = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  for (const edge of edges) {
    predecessors.get(edge.to)?.push(edge.from)
    successors.get(edge.from)?.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  const remaining = new Map(indegree)
  const order: string[] = []
  const seen = new Set<string>()

  function runFrom(seed: string) {
    const queue = [seed]
    while (queue.length > 0) {
      const id = queue.shift() as string
      if (seen.has(id)) {
        continue
      }
      seen.add(id)
      order.push(id)
      for (const next of successors.get(id) ?? []) {
        const left = (remaining.get(next) ?? 0) - 1
        remaining.set(next, left)
        if (left === 0) {
          queue.push(next)
        }
      }
    }
  }

  // The entrypoint's own reachable subgraph orders first — that is the run's actual sequence.
  if (entrypoint !== null && (indegree.get(entrypoint) ?? 0) === 0) {
    runFrom(entrypoint)
  }
  // Anything else (a second source, an orphan dropped with no edges yet) has no defined rank
  // in TEAM_CONFIG.md, so it orders after, deterministically by `nodeIds` order.
  for (const id of nodeIds) {
    if (!seen.has(id) && (remaining.get(id) ?? 0) === 0) {
      runFrom(id)
    }
  }
  // Cycles are refused at draw time (edgeRules.wouldCreateCycle); this is only reachable if
  // that guard was bypassed, so append whatever is left rather than dropping it silently.
  for (const id of nodeIds) {
    if (!seen.has(id)) {
      order.push(id)
    }
  }

  return order.map((id, index) => {
    const preds = predecessors.get(id) ?? []
    return { id, step: index + 1, joinFrom: preds.length > 1 ? preds : [] }
  })
}
