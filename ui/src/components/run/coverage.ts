import type { CoverageKey, Evidence, RunProjection } from '../../lib/watch/events'
import type { Coverage, EntityKind } from '../ui/glyphs'

// TNG89 §4.1 / CONTRACT §12: six grouped summaries in fixed order — agents, reasoning,
// skills, tools, commands, sources. Fixed order matters: the operator learns positions, and
// a list that reorders itself by count is unlearnable. Shared by the wide ProvenancePanel
// and the narrow RunColumn so the two surfaces cannot drift into different orders.
export interface ProvenanceCategory {
  key: CoverageKey
  kind: EntityKind
  label: string
  kinds: Evidence['kind'][]
}

export const CATEGORIES: ProvenanceCategory[] = [
  { key: 'agents', kind: 'agent', label: 'agents', kinds: [] },
  { key: 'reasoning', kind: 'reasoning', label: 'reasoning', kinds: ['plan'] },
  { key: 'skills', kind: 'skill', label: 'skills', kinds: ['skill'] },
  { key: 'tools', kind: 'tool', label: 'tools', kinds: ['tool', 'delegation', 'permission'] },
  { key: 'commands', kind: 'command', label: 'commands', kinds: ['command'] },
  { key: 'sources', kind: 'source', label: 'sources', kinds: ['file', 'search', 'source'] },
]

// §5.1: an `unavailable` category always states its reason — a restatement of the count
// ("Nothing captured for tools.") reads as a bug, a reason reads as an honest boundary.
export const EMPTY_REASONS: Record<CoverageKey, string> = {
  agents: 'No agents were reported for this run.',
  reasoning: 'No thought or plan events were recorded. Hidden chain-of-thought is never requested.',
  skills: 'No recorded skill activity. Prompt or filesystem presence alone is never treated as use.',
  tools: 'No tool calls were recorded for this run.',
  commands: 'No commands were recorded. Commands appear only when the adapter reports an `execute` tool kind.',
  sources: 'No files, searches or fetches were recorded.',
}

// CONTRACT §12: each category publishes `level: complete|partial|unavailable` with a
// stable reason code, derived by the projector from what the run actually observed —
// terminal agents, paired calls, unskipped events — and overridable by a daemon-published
// level (§10 projection_limit). A surface reads that level and never invents one: a level
// derived here from a count would claim "Complete capture" for a run still streaming,
// with calls unpaired, or after a trace limit silently dropped entities (§5.2, TNG-162).
export function coverageFor(key: CoverageKey, projection: RunProjection): Coverage {
  return projection.coverage[key].level
}

// §6.4: the summary chip's coverage word in the accessible name.
export function coverageWord(level: Coverage): string {
  return level === 'complete' ? 'complete' : level === 'partial' ? 'partial' : 'not captured'
}

// §5.2 names the gaps in full, no truncation: "reasoning, skills, tools, commands and sources".
function listNames(labels: string[]): string {
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

export interface CoverageSummary {
  levels: Coverage[]
  /** §4.1: "Complete capture" is permitted only when every category is complete. */
  complete: boolean
  /** The §5.2 sentence: "Complete capture" or "Partial capture — <gaps>." */
  text: string
}

/**
 * The one honesty statement for a run (§5.2), built once and read by every surface.
 *
 * TNG-173: the narrow column states coverage on its own face because ProvenancePanel is an
 * overlay there. Two independently-built sentences could disagree — the column claiming
 * "Complete capture" while the panel names gaps is exactly the failure §5 exists to prevent —
 * so both call this.
 */
export function coverageSummary(projection: RunProjection): CoverageSummary {
  const levels = CATEGORIES.map((category) => coverageFor(category.key, projection))
  const complete = levels.every((level) => level === 'complete')
  const gapClauses: string[] = []
  for (const level of ['unavailable', 'partial'] as const) {
    const labels = CATEGORIES.filter((_, index) => levels[index] === level).map((category) => category.label)
    if (labels.length > 0) gapClauses.push(level === 'unavailable' ? `nothing captured for ${listNames(labels)}` : `${listNames(labels)} partial`)
  }
  return { levels, complete, text: complete ? 'Complete capture' : `Partial capture — ${gapClauses.join('; ')}.` }
}
