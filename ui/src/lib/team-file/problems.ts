import { LineCounter, parseDocument } from 'yaml'

import type { EntrypointProblem } from './useTeamDocument'
import type { AgentField, AgentFieldProblems, DocumentProblem } from './validation'

const FIELD_LABELS: Record<AgentField, string> = { name: 'Name', role: 'Role', model: 'Model', cwd: 'Working directory', limitUsd: 'Budget' }

/** The schedule editor writes these four; the rest it repairs on save (lib/team-file/schedule.ts),
 * so every message names the fix the operator can actually reach from the schedule panel. */
const SCHEDULE_FIELD_COPY: Record<string, Pick<ReviewProblem, 'title' | 'message'>> = {
  cron: { title: 'Schedule · Time', message: 'Choose when this team should run.' },
  timezone: { title: 'Schedule · Timezone', message: 'Choose a recognized timezone.' },
  prompt: { title: 'Schedule · Task', message: 'Add what the team should do each time it runs.' },
  enabled: { title: 'Schedule · On or off', message: 'A schedule is either on or off and cannot hold anything else. Saving the schedule resets it.' },
  deliver: { title: 'Schedule · Delivery', message: 'The delivery settings are incomplete. Saving the schedule clears them; Advanced YAML keeps them.' },
}

function friendlyDocumentProblem(problem: DocumentProblem): Pick<ReviewProblem, 'title' | 'message'> {
  if (problem.yamlPath?.[0] === 'schedule') {
    const field = problem.yamlPath[1]
    if (typeof field === 'string' && SCHEDULE_FIELD_COPY[field]) return SCHEDULE_FIELD_COPY[field]
    if (typeof field === 'string') return { title: `Schedule · ${field}`, message: `“${field}” is not one of a schedule's settings. Saving the schedule removes it.` }
    return { title: 'Schedule needs attention', message: 'This schedule does not match the format LoomWatch expects. Saving the schedule rewrites it.' }
  }
  return {
    title: problem.edge ? `Edge · ${problem.edge.from} → ${problem.edge.to}` : problem.agentId ? problem.agentId : 'Team',
    message: problem.message,
  }
}

export interface ReviewProblem extends DocumentProblem {
  weight: 'incomplete' | 'error'
  title: string
  field?: AgentField
}

/** `/Users/me/Developer/loomwatch/teams` → `~/Developer/loomwatch/teams`, middle-truncated past ~40 chars. */
export function shortenDirectory(directory: string): string {
  const home = directory.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  if (home.length <= 40) return home
  const parts = home.split('/')
  const tail = parts.slice(-2).join('/')
  return `${parts[0]}/…/${tail}`
}

/** Collects every problem the chip counts so a counted problem can never vanish from Review. */
export function reviewProblems(entrypointProblem: EntrypointProblem | null, fieldProblemsByAgent: ReadonlyMap<string, AgentFieldProblems>, documentProblems: DocumentProblem[], agentNames: ReadonlyMap<string, string>): ReviewProblem[] {
  const fields: ReviewProblem[] = Array.from(fieldProblemsByAgent, ([agentId, problems]) =>
    (Object.entries(problems) as [AgentField, NonNullable<AgentFieldProblems[AgentField]>][]).map(([field, problem]) => ({
      message: problem.message,
      agentId,
      field,
      yamlPath: ['agents'],
      weight: problem.weight,
      title: `${agentNames.get(agentId) ?? agentId} · ${FIELD_LABELS[field]}`,
    }))).flat()
  return [
    ...(entrypointProblem ? [{ message: entrypointProblem.message, yamlPath: ['entrypoint'], weight: 'error' as const, title: 'Team · Entry point' }] : []),
    ...fields,
    ...documentProblems.map((problem) => {
      const friendly = friendlyDocumentProblem(problem)
      return { ...problem, message: friendly.message, weight: 'error' as const, title: problem.agentId && problem.yamlPath?.[0] !== 'schedule' ? (agentNames.get(problem.agentId) ?? friendly.title) : friendly.title }
    }),
  ]
}

/** Resolve a validation path against the CST so Review can take the operator to source. */
export function yamlLineForPath(yaml: string, path: readonly (string | number)[] | undefined): number {
  if (!yaml.trim()) return 1
  const lineCounter = new LineCounter()
  const document = parseDocument(yaml, { lineCounter })
  let target = path && path.length > 0 ? document.getIn(path, true) : document.contents
  if (!target && path && path.length > 1) target = document.getIn(path.slice(0, -1), true)
  const range = target && typeof target === 'object' && 'range' in target
    ? (target as { range?: readonly number[] }).range
    : document.contents?.range
  return range?.[0] !== undefined ? lineCounter.linePos(range[0]).line : 1
}
