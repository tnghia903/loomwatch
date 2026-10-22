import type { TeamView } from './useTeamList'

/** A team's address, on one of its views. Workflow is the address with no `view`. On its own, so
    a page without the canvas (the island at the notch) can link to a team. */
export function teamHref(path: string, view: TeamView = 'workflow'): string {
  return `/?path=${encodeURIComponent(path)}${view === 'workflow' ? '' : `&view=${view}`}`
}
