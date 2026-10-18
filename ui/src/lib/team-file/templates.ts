import { stringify } from 'yaml'

import { modelForJob, NEW_AGENT } from '../ai/modelIds'
import { buildAgentFromSource } from '../library/createAgent'
import { savedJobPreset, type SavedJob } from '../library/jobs'
import { modelForPreset, ROLE_PRESETS, roleSource } from '../library/roles'
import type { AgentConfig, EdgeConfig } from './types'
import { slugifyTeamName } from './useTeamDocument'
import { NEW_TEAM_PER_RUN_USD } from '../runs/spend'

/**
 * Starter teams for the New team dialog.
 *
 * A first-time operator should reach a runnable team in one step, not by learning what an
 * entrypoint, a model id or a configured edge is. Each template is a complete, schema-valid team
 * file: it is written to disk as-is and opened, so the very first thing the operator can do is
 * type a request and press Enter. There is no empty team: a team always starts with agents, from a
 * template or from Your agents (`agentsTeamYaml`).
 */
export type TeamTemplateId = 'single' | 'research-write' | 'research-write-check' | 'research-review-write' | 'research'

export interface TeamTemplate {
  id: TeamTemplateId
  title: string
  description: string
  /** Steps shown as a small diagram, in order. */
  steps: readonly string[]
  /** What each run of it starts, said where the choice is made: every agent that works is a
      session of its own, so this is what decides most of what a run costs. */
  perRun?: string
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
    perRun: 'One agent works on each run, so it uses the fewest tokens.',
    example: { title: 'Three ways to speed up the build', lines: ['1. Cache dependencies between runs', '2. Split the test suite in two', '3. Skip unchanged packages'] },
  },
  {
    id: 'research-write',
    title: 'Researcher and writer',
    description: 'One agent gathers the facts, a second turns them into the finished result.',
    steps: ['Researcher', 'Writer'],
    perRun: 'Two agents work on each run, with a handover between them.',
    example: { title: 'Market brief: AI note-taking', lines: ['Three tools lead; two launched this year', 'Prices cluster around $10–20 a month', 'Sources: 6 articles, 2 pricing pages'] },
  },
  {
    id: 'research-write-check',
    title: 'Research, write and check',
    description: 'A third agent checks the finished piece against what it must have, and says what it missed.',
    steps: ['Researcher', 'Writer', 'Checker'],
    // Measured on a real run (ADR 0062): the checker re-opened every source, 188k of 393k tokens.
    perRun: 'Three agents work on each run. The checker re-opens the writer’s sources, so it can cost as much as the research.',
    example: { title: 'Market brief: AI note-taking', lines: ['Three tools lead; two launched this year', 'Prices cluster around $10–20 a month', 'Checks: every claim linked, 120 words'], note: 'Checked by the Checker before you read it' },
  },
  {
    id: 'research-review-write',
    title: 'Research, your approval, then writing',
    description: 'The team pauses after research so you can approve it or ask for changes.',
    steps: ['Researcher', 'You', 'Writer'],
    perRun: 'Two agents work on each run. Your review in between uses no tokens.',
    example: { title: 'Competitor summary', lines: ['Acme shipped a team canvas', 'Northwind cut prices by 20%', 'Globex is hiring for agents'], note: 'You approved the research before writing' },
  },
  {
    // Open Deep Research's shape (MIT, credited on the Research lead job): a lead plans, the
    // research runs in parallel, a writer reports with a citation on every claim.
    id: 'research',
    title: 'Research team',
    description: 'A lead splits your question, researchers look into each part at the same time, and a writer turns what they found into a report that cites every source.',
    steps: ['Lead', 'Researchers', 'Writer'],
    perRun: 'Four to six agents work on each run: the lead, a researcher for each part of the question, and the writer. It costs the most, and suits a question that needs many sources.',
    example: { title: 'Report: should we move to a four-day week?', lines: ['What the trials measured, and what changed [1][2]', 'Where the results disagree, and why [3]', 'Sources: 12, each cited beside its claim'], note: 'Three researchers worked on it at the same time' },
  },
]

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
  review: 'Read the research. Approve it, or say what should change before writing starts.',
} as const

/**
 * A template's Researcher and Writer are the palette's jobs of the same name, so a starter team and
 * a team built by hand get the same instructions.
 */
function jobRole(id: 'lead' | 'researcher' | 'writer' | 'checker'): string {
  const preset = ROLE_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) throw new Error(`no built-in job ${id}`)
  return preset.role
}

function agent(id: string, name: string, role: string): AgentConfig {
  // The Researcher job's own switches (ADR 0037), so a template's researcher can search the web
  // like one hired from the palette; each job's model tier (ADR 0057) and effort (ADR 0062).
  const preset = ROLE_PRESETS.find((candidate) => candidate.id === id)
  const choice = preset ? modelForPreset(preset) : modelForJob(NEW_AGENT)
  return {
    id,
    name,
    role,
    model: choice.model,
    ...(choice.thinkingEffort ? { thinkingEffort: choice.thinkingEffort } : {}),
    ...(preset?.doneWhen?.length ? { doneWhen: [...preset.doneWhen] } : {}),
    ...(preset?.allow ? { allow: { ...preset.allow } } : {}),
  }
}

function sequence(from: string, to: string, ts: string): EdgeConfig {
  return { from, to, layer: 'configured', kind: 'sequence', ts }
}

/**
 * The team file for a template, as YAML text ready to save. Each agent runs on its job's model.
 * `id` should come from the file the team is saved as (`teamIdForPath`), so a second team with the
 * same name does not share the first one's id, and with it the first one's Notebook.
 */
export function templateTeamYaml(template: TeamTemplateId, name: string, now = new Date(), id = slugifyTeamName(name)): string {
  const ts = now.toISOString()
  let agents: AgentConfig[]
  let edges: EdgeConfig[]
  if (template === 'single') {
    agents = [agent('assistant', 'Assistant', ROLES.assistant)]
    edges = []
  } else if (template === 'research-write') {
    agents = [agent('researcher', 'Researcher', jobRole('researcher')), agent('writer', 'Writer', jobRole('writer'))]
    edges = [sequence('researcher', 'writer', ts)]
  } else if (template === 'research-write-check') {
    agents = [
      agent('researcher', 'Researcher', jobRole('researcher')),
      agent('writer', 'Writer', jobRole('writer')),
      // The check step's answer is the writer's piece; its checks show beside it (ADR 0062).
      { ...agent('checker', 'Checker', jobRole('checker')), checks: 'writer' },
    ]
    edges = [sequence('researcher', 'writer', ts), sequence('writer', 'checker', ts)]
  } else if (template === 'research') {
    // No edges, so the lead is the entrypoint and its reply is the answer; it reaches the others
    // through the Team Bus: `dispatch` to the Researcher once per sub-question, each its own
    // session working in parallel, then `ask` to the Writer.
    agents = [
      agent('lead', 'Research lead', jobRole('lead')),
      agent('researcher', 'Researcher', jobRole('researcher')),
      agent('writer', 'Writer', jobRole('writer')),
    ]
    edges = []
  } else {
    agents = [
      agent('researcher', 'Researcher', jobRole('researcher')),
      { id: 'review', kind: 'operator', name: 'You', role: ROLES.review },
      agent('writer', 'Writer', jobRole('writer')),
    ]
    edges = [sequence('researcher', 'review', ts), sequence('review', 'writer', ts)]
  }
  return stringify({ schemaVersion: 1, id, name: name.trim(), spend: { perRun: NEW_TEAM_PER_RUN_USD }, entrypoint: agents[0].id, agents, edges }, { lineWidth: 0 })
}

/**
 * A team of some of Your agents, as YAML text ready to save. Each joins as the canvas places one:
 * a copy of its current version, linked to it, so the team keeps that version until Update. The
 * first is where a request starts; connecting the rest is the Workflow's job, as it is for agents
 * added later. `agents` must not be empty: a team always starts with agents.
 */
export function agentsTeamYaml(agents: readonly SavedJob[], name: string, id = slugifyTeamName(name)): string {
  if (agents.length === 0) throw new Error('a team starts with at least one agent')
  const placed: AgentConfig[] = []
  for (const job of agents) placed.push(buildAgentFromSource(roleSource(savedJobPreset(job)), placed))
  return stringify({ schemaVersion: 1, id, name: name.trim(), spend: { perRun: NEW_TEAM_PER_RUN_USD }, entrypoint: placed[0].id, agents: placed, edges: [] }, { lineWidth: 0 })
}
