import { stringify } from 'yaml'

import { isHarnessRunnable, type DetectedHarness } from '../harnesses'
import type { AgentConfig, EdgeConfig } from './types'
import { slugifyTeamName } from './useTeamDocument'

/**
 * Starter teams for the New team dialog.
 *
 * A first-time operator should reach a runnable team in one step, not by learning what an
 * entrypoint, a model id or a configured edge is. Each template is a complete, schema-valid team
 * file: it is written to disk as-is and opened, so the very first thing the operator can do is
 * type a request and press Enter. `blank` is the one exception — it has no agents, so it cannot be
 * saved yet and opens as an unsaved document instead.
 */
export type TeamTemplateId = 'single' | 'research-write' | 'research-review-write' | 'blank'

export interface TeamTemplate {
  id: TeamTemplateId
  title: string
  description: string
  /** Steps shown as a small diagram, in order. */
  steps: readonly string[]
  /**
   * What a finished run of this template looks like, drawn as a thumbnail so the operator picks by
   * outcome rather than by wiring. Always labelled as an example: nothing has run yet.
   */
  example?: { title: string; lines: readonly string[]; note?: string }
}

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: 'single',
    title: 'One assistant',
    description: 'A single AI agent does the whole task. The easiest way to start.',
    steps: ['Assistant'],
    example: { title: 'Three ways to speed up the build', lines: ['1. Cache dependencies between runs', '2. Split the test suite in two', '3. Skip unchanged packages'] },
  },
  {
    id: 'research-write',
    title: 'Researcher and writer',
    description: 'One agent gathers the facts, a second turns them into the finished result.',
    steps: ['Researcher', 'Writer'],
    example: { title: 'Market brief: AI note-taking', lines: ['Three tools lead; two launched this year', 'Prices cluster around $10–20 a month', 'Sources: 6 articles, 2 pricing pages'] },
  },
  {
    id: 'research-review-write',
    title: 'Research, your approval, then writing',
    description: 'The team pauses after research so you can approve it or ask for changes.',
    steps: ['Researcher', 'You', 'Writer'],
    example: { title: 'Competitor summary', lines: ['Acme shipped a team canvas', 'Northwind cut prices by 20%', 'Globex is hiring for agents'], note: 'You approved the research before writing' },
  },
  {
    id: 'blank',
    title: 'Empty team',
    description: 'Start from a blank canvas and add agents yourself.',
    steps: [],
  },
]

/** Harnesses most people already have signed in, in the order a template should prefer them. */
const PREFERRED_HARNESSES = ['claude', 'codex', 'opencode', 'gemini']

/**
 * The runnable harnesses, best first. A template is built on the first one that answers, so an app
 * the daemon last saw fail to start is left out rather than tried again on the operator's time.
 */
export function rankHarnesses(harnesses: readonly DetectedHarness[]): DetectedHarness[] {
  const runnable = harnesses.filter(isHarnessRunnable)
  const rank = (id: string) => {
    const index = PREFERRED_HARNESSES.indexOf(id)
    return index === -1 ? PREFERRED_HARNESSES.length : index
  }
  return [...runnable].sort((a, b) => rank(a.id) - rank(b.id))
}

/**
 * A file name for `name` that does not collide with `existing`.
 *
 * New team files are created with `If-None-Match: *`, so a collision is a refused save rather than
 * an overwrite — but the operator should never be asked to rename a team because of a file they
 * cannot see.
 */
export function uniqueTeamPath(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((path) => path.toLowerCase()))
  const base = slugifyTeamName(name)
  let candidate = `${base}.yaml`
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) candidate = `${base}-${suffix}.yaml`
  return candidate
}

const ROLES = {
  assistant: 'Complete the request you are given. Work carefully, then reply with the finished result.',
  researcher: 'Research the request. Collect the facts, sources and open questions the writer will need, and hand them over clearly.',
  writer: 'Turn what you were handed into the finished result the request asks for. Keep it accurate, clear and ready to use.',
  review: 'Read the research. Approve it, or say what should change before writing starts.',
} as const

function agent(id: string, name: string, role: string, harness: DetectedHarness, model: string): AgentConfig {
  return {
    id,
    name,
    role,
    spawn: { cmd: harness.spawn.cmd, args: [...harness.spawn.args], env: {}, cwd: '.' },
    model,
  }
}

function sequence(from: string, to: string, ts: string): EdgeConfig {
  return { from, to, layer: 'configured', kind: 'sequence', ts }
}

/**
 * The team file for a non-blank template, as YAML text ready to save.
 *
 * `model` must be an id the harness itself advertised (its current model, normally): a harness
 * that advertises models rejects an id it does not know, which would fail the first run.
 */
/** `id` should come from the file the team is saved as (`teamIdForPath`), so a second team with
 * the same name does not share the first one's id, and with it the first one's Notebook. */
export function templateTeamYaml(template: Exclude<TeamTemplateId, 'blank'>, name: string, harness: DetectedHarness, model: string, now = new Date(), id = slugifyTeamName(name)): string {
  const ts = now.toISOString()
  let agents: AgentConfig[]
  let edges: EdgeConfig[]
  if (template === 'single') {
    agents = [agent('assistant', 'Assistant', ROLES.assistant, harness, model)]
    edges = []
  } else if (template === 'research-write') {
    agents = [agent('researcher', 'Researcher', ROLES.researcher, harness, model), agent('writer', 'Writer', ROLES.writer, harness, model)]
    edges = [sequence('researcher', 'writer', ts)]
  } else {
    agents = [
      agent('researcher', 'Researcher', ROLES.researcher, harness, model),
      { id: 'review', kind: 'operator', name: 'You', role: ROLES.review },
      agent('writer', 'Writer', ROLES.writer, harness, model),
    ]
    edges = [sequence('researcher', 'review', ts), sequence('review', 'writer', ts)]
  }
  return stringify({ schemaVersion: 1, id, name: name.trim(), entrypoint: agents[0].id, agents, edges }, { lineWidth: 0 })
}
