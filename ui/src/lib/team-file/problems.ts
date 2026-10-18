import type { EntrypointProblem } from './useTeamDocument'
import type { AgentField, AgentFieldProblems, DocumentProblem } from './validation'

const FIELD_LABELS: Record<AgentField, string> = { name: 'Name', role: 'Instructions', model: 'Model', cwd: 'Working folder' }

/** The schedule editor writes these four; the rest it repairs on save (lib/team-file/schedule.ts),
 * so every message names the fix the operator can actually reach from the schedule panel. */
const SCHEDULE_FIELD_COPY: Record<string, Pick<ReviewProblem, 'title' | 'message'>> = {
  cron: { title: 'Schedule · Time', message: 'Choose when this team should run.' },
  timezone: { title: 'Schedule · Timezone', message: 'Choose a recognized timezone.' },
  prompt: { title: 'Schedule · Task', message: 'Add what the team should do each time it runs.' },
  enabled: { title: 'Schedule · On or off', message: 'A schedule is either on or off and cannot hold anything else. Saving the schedule resets it.' },
  deliver: { title: 'Schedule · Delivery', message: 'The delivery settings are incomplete. Saving the schedule clears them.' },
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

/**
 * `/Users/me/Developer/loomwatch/teams` → `~/Developer/loomwatch/teams` (and `C:\Users\me\…` →
 * `~\…` on Windows), middle-truncated past ~40 chars.
 */
export function shortenDirectory(directory: string): string {
  const home = directory.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')
  if (home.length <= 40) return home
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  const parts = home.split(/[\\/]/)
  const tail = parts.slice(-2).join(separator)
  return `${parts[0]}${separator}…${separator}${tail}`
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
    // An empty team is unfinished, not wrong: it is the state every new team starts in.
    ...(entrypointProblem ? [entrypointProblem.candidates.length === 0
      ? { message: 'Click + next to a job in the library on the left, such as Researcher.', yamlPath: ['entrypoint'], weight: 'incomplete' as const, title: 'Add your first agent' }
      : { message: 'Choose which agent receives your request first.', yamlPath: ['entrypoint'], weight: 'error' as const, title: 'Choose a starting agent' }] : []),
    ...fields,
    ...documentProblems.map((problem) => {
      const friendly = friendlyDocumentProblem(problem)
      return { ...problem, message: friendly.message, weight: 'error' as const, title: problem.agentId && problem.yamlPath?.[0] !== 'schedule' ? (agentNames.get(problem.agentId) ?? friendly.title) : friendly.title }
    }),
  ]
}
