import type { AgentConfig } from '../team-file/types'
import type { LibrarySource } from './types'

const DEFAULT_BUDGET_USD = 5

// $defs.Identifier (schemas/team.schema.yaml): ^[A-Za-z0-9][A-Za-z0-9._-]*$
function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'agent'
}

function uniqueId(base: string, existingIds: ReadonlySet<string>): string {
  if (!existingIds.has(base)) {
    return base
  }
  let suffix = 2
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

/**
 * Builds the agent a drop creates (docs/CANVAS_SPEC.md §4.5 step 4).
 *
 * `role` and `model` stay empty for a bare harness/endpoint source — deliberately, per §4.5:
 * "a role is the whole point of the node, and GET /api/harnesses advertises no models" — which
 * makes the document invalid until the operator fills them in. A preset source pre-fills both,
 * "the entire argument for presets." `budget.limitUsd` always follows the doc-inheritance rule
 * (last node created, else $5) regardless of source kind — a preset's own suggested budget is
 * display-only in the Library row, not written to the agent.
 */
export function buildAgentFromSource(
  source: LibrarySource,
  existingAgents: readonly AgentConfig[],
): AgentConfig {
  const existingIds = new Set(existingAgents.map((agent) => agent.id))
  const id = uniqueId(slugify(source.label), existingIds)
  if (source.kind === 'operator') return { id, kind: 'operator', name: source.label, role: source.role ?? 'Review the work and say what should happen next.' }
  const inheritedBudget = existingAgents.findLast((agent) => agent.kind !== 'operator')?.budget?.limitUsd

  return {
    id,
    name: source.label,
    role: source.role ?? '',
    model: source.model ?? '',
    spawn: {
      cmd: source.spawn.cmd,
      args: [...source.spawn.args],
      env: {},
      cwd: '.',
    },
    budget: { limitUsd: inheritedBudget ?? DEFAULT_BUDGET_USD },
    allowRecruiting: true,
  }
}
