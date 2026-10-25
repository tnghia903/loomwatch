import { uniqueLabel } from '../composer-layout/types'
import { jobIdFor, onlyOn, toolAllowOf, versionOf, type JobSpec, type SavedJob } from '../library/jobs'
import { knowledgeOf, readKey } from '../library/reads'
import { capabilitiesOf } from '../library/roles'
import { TeamFileModel } from './document'
import type { AgentConfig, CapabilityRef, TurnedOff } from './types'

/**
 * Every agent lives in My agents (ADR 0094).
 *
 * A team file's agent entry points at one of the person's agents, `from: {agent}`, and holds only
 * what is the team's: where it works, what the team connects to it beyond what it reads itself, its
 * place in the flow, what the team turned off for it, its spending guard there and whether it learns
 * there. The agent's own fields come from My agents each time the team is read, and a change made to
 * them in a team is saved to the agent, for every team.
 *
 * An entry that still holds instructions of its own (`role`) runs as it is written. The daemon
 * fills a team the same way (`crates/loomwatch-backend/src/my_agents.rs`); both are tested with
 * the cases in `schemas/my-agents.cases.json`.
 */

type Entry = Record<string, unknown>

/** The fields that are the agent's in every team, beside its skills, tools and what it reads. */
const AGENT_KEYS = ['name', 'role', 'doneWhen', 'allow', 'allowRecruiting'] as const

/**
 * The agent in My agents an entry points at, when it holds none of the agent's own fields and so
 * is filled in from there: not a review stop, and no `role` of its own.
 */
export function pointsAt(entry: Pick<AgentConfig, 'kind' | 'from'> & { role?: unknown }): string | null {
  if (entry.kind === 'operator' || entry.role !== undefined) return null
  return entry.from?.agent ?? null
}

/** What the team connected to the agent beyond what it reads itself. */
function teamKnowledge(capabilities: readonly CapabilityRef[] | undefined, job: Pick<JobSpec, 'reads'>): CapabilityRef[] {
  const reads = new Set((job.reads ?? []).map(readKey))
  return (capabilities ?? []).filter((capability) => capability.kind === 'knowledge' && !reads.has(readKey(capability)))
}

/** The skills and tools the team wired to the agent on its canvas beyond the agent's own: given in that team only. */
function teamSkillsAndTools(capabilities: readonly CapabilityRef[] | undefined, job: Pick<JobSpec, 'skills' | 'tools'>): CapabilityRef[] {
  const skills = new Set(job.skills ?? [])
  const tools = new Set(job.tools ?? [])
  return (capabilities ?? []).filter((capability) => (capability.kind === 'skill' && !skills.has(capability.name)) || (capability.kind === 'tool' && !tools.has(capability.name)))
}

const offKey = (entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`

/**
 * `entry` with agent `agent`'s fields from My agents filled in over it: what the entry would hold
 * were the agent written out in full. Everything that is the team's stays as the entry has it.
 */
export function filledAgent(entry: Entry, agent: string, job: JobSpec): Entry {
  const filled: Entry = { ...entry, name: job.name, role: job.instructions }
  if (job.model) {
    // The effort goes with the model it belongs to, and a model the agent names is its own choice.
    filled.model = job.model
    if (job.thinkingEffort) filled.thinkingEffort = job.thinkingEffort
    else delete filled.thinkingEffort
    delete filled.followsSuggestion
  }
  // What the team connected, then what the agent reads (each label once), its skills and its tools
  // less what the team turned off (ADR 0060), then the skills and tools the team gives it besides.
  const given = entry.capabilities as CapabilityRef[] | undefined
  const kept = teamKnowledge(given, job)
  const taken = new Set(kept.map((capability) => capability.name))
  const reads = knowledgeOf(job.reads ?? []).map((capability) => ({ ...capability, name: uniqueLabel(capability.name, taken) }))
  const off = new Set(((entry.turnedOff ?? []) as TurnedOff[]).map(offKey))
  const own = capabilitiesOf(job.skills ?? [], job.tools ?? [], job.toolAllow ?? {}).filter((capability) => !off.has(offKey(capability)))
  const capabilities = [...kept, ...reads, ...own, ...teamSkillsAndTools(given, job)]
  if (capabilities.length > 0) filled.capabilities = capabilities
  else delete filled.capabilities
  if (job.doneWhen?.length) filled.doneWhen = [...job.doneWhen]
  else delete filled.doneWhen
  const allow = onlyOn(job.allow)
  if (allow) filled.allow = allow
  else delete filled.allow
  if (job.helpers === false) filled.allowRecruiting = false
  else delete filled.allowRecruiting
  filled.from = { agent }
  return filled
}

/** `entry` as the team file keeps it: a pointer at agent `agent` with only the team's fields. */
export function pointerEntry(entry: Entry, agent: string, job: JobSpec): Entry {
  const pointer: Entry = { ...entry }
  for (const key of AGENT_KEYS) delete pointer[key]
  if (job.model) {
    delete pointer.model
    delete pointer.thinkingEffort
    delete pointer.followsSuggestion
  }
  const given = entry.capabilities as CapabilityRef[] | undefined
  const team = [...teamKnowledge(given, job), ...teamSkillsAndTools(given, job)]
  if (team.length > 0) pointer.capabilities = team
  else delete pointer.capabilities
  pointer.from = { agent }
  return pointer
}

const unique = (names: readonly string[]) => [...new Set(names)]
const sameList = (a: readonly unknown[] = [], b: readonly unknown[] = []) => JSON.stringify(a) === JSON.stringify(b)

function skillsOf(agent: Pick<AgentConfig, 'capabilities'>): string[] {
  return unique((agent.capabilities ?? []).filter((capability) => capability.kind === 'skill').map((capability) => capability.name))
}

function toolsOf(agent: Pick<AgentConfig, 'capabilities'>): string[] {
  return unique((agent.capabilities ?? []).filter((capability) => capability.kind === 'tool').map((capability) => capability.name))
}

/** The agent's fields as a new agent in My agents is saved with them, from a team's entry. */
export function specOf(agent: AgentConfig): JobSpec {
  const skills = skillsOf(agent)
  const tools = toolsOf(agent)
  const toolAllow = toolAllowOf(agent)
  const reads = (agent.capabilities ?? [])
    .filter((capability) => capability.kind === 'knowledge')
    .map((capability) => ({ name: capability.name, ...(capability.notion ? { notion: { page: capability.notion.page } } : { path: capability.path ?? '' }) }))
  const allow = onlyOn(agent.allow)
  return {
    name: agent.name,
    instructions: agent.role,
    // A model the app suggests for this team stays the team's: the agent names none of its own.
    ...(agent.model && !agent.followsSuggestion ? { model: agent.model, ...(agent.thinkingEffort ? { thinkingEffort: agent.thinkingEffort } : {}) } : {}),
    ...(skills.length ? { skills } : {}),
    ...(tools.length ? { tools } : {}),
    ...(Object.keys(toolAllow).length ? { toolAllow } : {}),
    ...(reads.length ? { reads } : {}),
    ...(agent.doneWhen?.length ? { doneWhen: [...agent.doneWhen] } : {}),
    ...(allow ? { allow } : {}),
    ...(agent.allowRecruiting === false ? { helpers: false as const } : {}),
  }
}

/**
 * Agent `job` with what was changed on it in a team since it was filled in there (`before`, as the
 * team showed it then, and `now`): only the fields changed here move, so a change saved to the agent
 * elsewhere meanwhile stays, and a model the app suggests for this team never becomes the agent's.
 */
export function editedSpec(job: JobSpec, before: AgentConfig, now: AgentConfig): JobSpec {
  const spec: JobSpec = { ...job }
  if (now.name !== before.name) spec.name = now.name
  if (now.role !== before.role) spec.instructions = now.role
  if (!now.followsSuggestion && (now.model !== before.model || now.thinkingEffort !== before.thinkingEffort)) {
    spec.model = now.model
    spec.thinkingEffort = now.thinkingEffort
  }
  // A skill or tool wired or taken off on a team's canvas is that team's: kept in its file, or
  // turned off there. The agent's own change on its workbench. What it may always do with a tool of
  // its own is the agent's, wherever that was allowed.
  const allowNow = toolAllowOf(now)
  const allowBefore = toolAllowOf(before)
  const here = new Set(toolsOf(now))
  const toolAllow = { ...(job.toolAllow ?? {}) }
  let allowed = false
  for (const tool of job.tools ?? []) {
    if (!here.has(tool) || sameList(allowNow[tool], allowBefore[tool])) continue
    allowed = true
    if (allowNow[tool]?.length) toolAllow[tool] = allowNow[tool]
    else delete toolAllow[tool]
  }
  if (allowed) spec.toolAllow = toolAllow
  // A read of its own taken off this team's card is taken off the agent.
  const kept = new Set((now.capabilities ?? []).filter((capability) => capability.kind === 'knowledge').map(readKey))
  const reads = (job.reads ?? []).filter((read) => kept.has(readKey(read)))
  if (reads.length !== (job.reads ?? []).length) spec.reads = reads
  if (!sameList(now.doneWhen, before.doneWhen)) spec.doneWhen = now.doneWhen ? [...now.doneWhen] : []
  if (JSON.stringify(onlyOn(now.allow) ?? {}) !== JSON.stringify(onlyOn(before.allow) ?? {})) spec.allow = onlyOn(now.allow)
  if ((now.allowRecruiting !== false) !== (before.allowRecruiting !== false)) spec.helpers = now.allowRecruiting === false ? false : undefined
  return tidy(spec)
}

/** `spec` with empty lists and absent switches left out, as the daemon keeps it. */
function tidy(spec: JobSpec): JobSpec {
  const tidied: JobSpec = { ...spec }
  for (const key of ['skills', 'tools', 'reads', 'doneWhen'] as const) if (!tidied[key]?.length) delete tidied[key]
  if (!tidied.toolAllow || Object.keys(tidied.toolAllow).length === 0) delete tidied.toolAllow
  if (!tidied.model) delete tidied.model
  if (!tidied.model || !tidied.thinkingEffort) delete tidied.thinkingEffort
  if (!onlyOn(tidied.allow)) delete tidied.allow
  if (tidied.helpers !== false) delete tidied.helpers
  return tidied
}

/** The fields a team takes from an agent, to tell whether a save changes any. */
export function agentFields(spec: JobSpec): string {
  const tidied = tidy(spec)
  return JSON.stringify([tidied.name, tidied.instructions, tidied.model, tidied.thinkingEffort, tidied.skills, tidied.tools, tidied.toolAllow, tidied.reads, tidied.doneWhen, tidied.allow, tidied.helpers])
}

/**
 * Whether an agent, as a team has it now, runs differently from how it was: its instructions, model
 * and effort, the skills, tools and reads it is given (however they are labelled), what it may
 * always do, Done when and its switches.
 */
export function runsDifferently(before: AgentConfig, after: AgentConfig): boolean {
  return runsWith(before) !== runsWith(after)
}

function runsWith(agent: AgentConfig): string {
  const capabilities = agent.capabilities ?? []
  const sorted = (keys: readonly string[]) => [...new Set(keys)].sort()
  return JSON.stringify([
    agent.role,
    agent.model ?? null,
    agent.thinkingEffort ?? null,
    sorted(capabilities.filter((capability) => capability.kind !== 'knowledge').map((capability) => `${capability.kind}:${capability.name}:${(capability.alwaysAllow ?? []).join(',')}`)),
    sorted(capabilities.filter((capability) => capability.kind === 'knowledge').map(readKey)),
    agent.doneWhen ?? [],
    onlyOn(agent.allow) ?? {},
    agent.allowRecruiting !== false,
  ])
}

/**
 * The id and name a team's own agent gets in My agents: its own when free; the agent already there
 * when it has exactly the same fields; otherwise its name with the team's after it, as in
 * "Writer · Market brief", so nothing silently changes what another team runs.
 */
export function placeInMyAgents(spec: JobSpec, jobs: readonly SavedJob[], teamName: string): { id: string; spec: JobSpec; existing: boolean } {
  const same = jobs.find((job) => agentFields(job) === agentFields(spec))
  if (same) return { id: same.id, spec: same, existing: true }
  const taken = new Set(jobs.map((job) => job.id))
  const clash = jobs.some((job) => job.name.trim().toLowerCase() === spec.name.trim().toLowerCase())
  const name = clash && teamName.trim() ? `${spec.name} · ${teamName.trim()}` : spec.name
  let id = jobIdFor(name)
  for (let counter = 2; taken.has(id); counter += 1) id = `${jobIdFor(name).slice(0, 60)}-${counter}`
  return { id, spec: { ...spec, name }, existing: false }
}

/**
 * Fill in every agent of `model` that points at one of My agents. Returns, by agent id in the team,
 * the agent it is in My agents and how it looked as read, which is what a save compares with: a
 * pointer as filled in, and a copy of one of My agents written out in full (a team from before the
 * move) as it was written, so only what is changed on it after reading reaches the agent.
 */
export function fillModel(model: TeamFileModel, jobs: readonly SavedJob[]): FilledAgents {
  const filled: FilledAgents = new Map()
  const agents = model.snapshot().agents
  for (const entry of Array.isArray(agents) ? agents : []) {
    if (entry.kind === 'operator') continue
    const agent = pointsAt(entry)
    if (!agent) {
      const copied = entry.from?.agent
      if (copied && jobs.some((candidate) => candidate.id === copied)) filled.set(entry.id, { agent: copied, before: entry })
      continue
    }
    const job = jobs.find((candidate) => candidate.id === agent)
    if (!job) continue
    const after = filledAgent(entry as unknown as Entry, agent, job)
    writeEntry(model, entry.id, entry as unknown as Entry, after)
    filled.set(entry.id, { agent, before: after as unknown as AgentConfig })
  }
  return filled
}

/** What a team document holds once its agents are filled in from My agents, for a reader that only shows it. */
export function filledTeam(yaml: string, jobs: readonly SavedJob[]): ReturnType<TeamFileModel['snapshot']> | null {
  try {
    const model = TeamFileModel.parse(yaml)
    fillModel(model, jobs)
    return model.snapshot()
  } catch {
    return null
  }
}

/** Where each agent of a team is in My agents, and how it looked when last filled in or saved. */
export type FilledAgents = Map<string, { agent: string; before: AgentConfig }>

/**
 * Before a team is saved, every agent on it becomes, or stays, one of My agents (ADR 0094):
 * - one that is one of My agents takes what was changed on it here to the agent, for every team.
 *   That is what changed since it was read (`filled`); for one added since, what it says
 *   differently from the agent. A copy written out in full (a team from before the move) thus
 *   gives way to the agent as it is in My agents, keeping only the changes made since reading it;
 * - the team's own agent becomes one of My agents, joining an identical one already there.
 * `model` is then shown pointing at each, as My agents has it. Returns My agents as they now are,
 * and how each agent looks now, which the next save compares with.
 */
export async function settleAgents(
  model: TeamFileModel,
  jobs: readonly SavedJob[],
  filled: FilledAgents,
  teamName: string,
  save: (id: string, spec: JobSpec, options?: { replace?: boolean; expectedVersion?: number }) => Promise<SavedJob>,
): Promise<{ jobs: SavedJob[]; filled: FilledAgents }> {
  const all = [...jobs]
  const next: FilledAgents = new Map()
  const agents = model.snapshot().agents
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent.kind === 'operator') continue
    const pointed = filled.get(agent.id)
    const job = all.find((candidate) => candidate.id === (pointed?.agent ?? agent.from?.agent))
    let saved: SavedJob
    if (job && (pointed || agent.from)) {
      const before = pointed?.before ?? filledAgent(agent as unknown as Entry, job.id, job) as unknown as AgentConfig
      const spec = editedSpec(job, before, agent)
      saved = agentFields(spec) === agentFields(job) ? job : await save(job.id, spec, { replace: true, expectedVersion: versionOf(job) })
    } else if (agent.role === undefined) {
      // It points at one of My agents that isn't there any more: nothing to save it as.
      continue
    } else {
      const place = placeInMyAgents(specOf(agent), all, teamName)
      saved = place.existing ? (all.find((candidate) => candidate.id === place.id) as SavedJob) : await save(place.id, place.spec)
    }
    const index = all.findIndex((candidate) => candidate.id === saved.id)
    if (index >= 0) all[index] = saved
    else all.push(saved)
    const current = agent as unknown as Entry
    const after = filledAgent(pointerEntry(current, saved.id, saved), saved.id, saved)
    writeEntry(model, agent.id, current, after)
    next.set(agent.id, { agent: saved.id, before: after as unknown as AgentConfig })
  }
  return { jobs: all, filled: next }
}

/**
 * A new team's file with its agents in My agents first (ADR 0094): one picked from there points at
 * it, and a built-in one joins an identical agent there or becomes a new one, so a change saved to
 * any of them reaches the new team too.
 */
export async function teamOfMyAgents(yaml: string, jobs: readonly SavedJob[], save: Parameters<typeof settleAgents>[4]): Promise<string> {
  const model = TeamFileModel.parse(yaml)
  const settled = await settleAgents(model, jobs, fillModel(model, jobs), model.snapshot().name ?? '', save)
  return diskYamlOf(model, settled.jobs)
}

/** The team file's text for `model`: each agent of My agents as a pointer with only the team's fields. */
export function diskYamlOf(model: TeamFileModel, jobs: readonly SavedJob[]): string {
  const disk = TeamFileModel.parse(model.toYaml())
  const agents = disk.snapshot().agents
  for (const agent of Array.isArray(agents) ? agents : []) {
    const job = agent.kind === 'operator' || agent.role === undefined ? undefined : jobs.find((candidate) => candidate.id === agent.from?.agent)
    if (!job) continue
    const entry = agent as unknown as Entry
    writeEntry(disk, agent.id, entry, pointerEntry(entry, job.id, job))
  }
  return disk.toYaml()
}

/** `model`'s agent `id` changed from `from` to `to`, key by key, so its comments and order stay. */
export function writeEntry(model: TeamFileModel, id: string, from: Entry, to: Entry): void {
  for (const key of Object.keys(from)) if (!(key in to)) model.setAgentField(id, key as keyof AgentConfig, undefined)
  for (const [key, value] of Object.entries(to)) {
    if (JSON.stringify(from[key]) !== JSON.stringify(value)) model.setAgentField(id, key as keyof AgentConfig, value as never)
  }
}
