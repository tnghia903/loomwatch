import type { LibrarySource } from './types'

/**
 * Endpoints and role presets have no backend yet (docs/CANVAS_SPEC.md §15.3: "Phase 04 builds
 * them against fixtures and ships them empty"). Endpoints ships empty — there is nothing to
 * fixture that isn't misleading, since a real endpoint is operator-supplied. Presets carry two
 * illustrative fixtures matching the §4 mockup so drag-to-instantiate has a "valid on drop"
 * path to exercise (§4.5) even before `GET /api/presets` exists.
 */
export const ENDPOINT_SOURCES: readonly LibrarySource[] = []

export const PRESET_SOURCES: readonly LibrarySource[] = [
  {
    group: 'presets',
    id: 'reviewer',
    label: 'Reviewer',
    role: 'Reviewer',
    model: 'claude-opus-5',
    budgetUsd: 5,
    spawn: { cmd: 'claude-agent-acp', args: [] },
  },
  {
    group: 'presets',
    id: 'protocol-researcher',
    label: 'Protocol Researcher',
    role: 'Protocol Researcher',
    model: 'k3-256k',
    budgetUsd: 5,
    spawn: { cmd: 'opencode', args: ['acp'] },
  },
]
