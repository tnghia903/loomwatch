import { stringify } from 'yaml'

import type { DetectedHarness } from '../harnesses'
import type { AgentAllow, AgentConfig } from '../team-file/types'
import { DEFAULT_AGENT_ROLE } from './createAgent'
import { isFigureChoice, type FigureChoice } from './figures'
import { guessIcon, onlyOn, versionOf, type JobSpec, type SavedJob } from './jobs'
import { capabilitiesOf, harnessForRole, type RolePreset } from './roles'

/**
 * The agent builder's working copy of one of Your agents: what is on screen, saved or not. Saving
 * turns it into a job spec (`specFromDraft`); its chat turns it into a one-agent team
 * (`chatTeamYaml`), so working with an agent never needs it saved first.
 */
export interface AgentDraft {
  name: string
  does: string
  instructions: string
  /** The app it runs on; `null` until one is chosen. */
  appId: string | null
  /** A model id of `appId`; empty means the app's own current model. */
  model: string
  /** One of that model's thinking efforts; empty means the app's own default. */
  effort: string
  skills: string[]
  /**
   * The tools it is given: MCP servers on this computer, by the name the capability scan lists. A
   * team copies them like its skills, and its Workflow canvas draws each as a card wired to it.
   */
  tools: string[]
  /** What the finished result must satisfy (ADR 0062); empty when nothing is set. */
  doneWhen: string[]
  allow: AgentAllow
  /** The figure it wears in Your agents; `null` wears the one its id picks. A team never copies it. */
  figure: FigureChoice | null
}

export const BLANK_DRAFT: AgentDraft = { name: '', does: '', instructions: DEFAULT_AGENT_ROLE, appId: null, model: '', effort: '', skills: [], tools: [], doneWhen: [], allow: {}, figure: null }

export function draftFromJob(job: JobSpec): AgentDraft {
  return {
    name: job.name,
    does: job.does ?? '',
    instructions: job.instructions,
    appId: job.apps?.[0] ?? null,
    model: job.apps?.length ? job.model ?? '' : '',
    effort: job.apps?.length && job.model ? job.thinkingEffort ?? '' : '',
    skills: [...(job.skills ?? [])],
    tools: [...(job.tools ?? [])],
    doneWhen: [...(job.doneWhen ?? [])],
    allow: { ...(onlyOn(job.allow) ?? {}) },
    figure: isFigureChoice(job.figure) ? { ...job.figure } : null,
  }
}

/** A built-in job as a new agent's starting point, on the best app this computer has for it. */
export function draftFromPreset(preset: RolePreset, harnesses: readonly DetectedHarness[]): AgentDraft {
  return {
    name: preset.label,
    does: preset.does,
    instructions: preset.role,
    appId: harnessForRole(preset, harnesses)?.id ?? null,
    model: '',
    effort: '',
    skills: [...(preset.skills ?? [])],
    tools: [...(preset.tools ?? [])],
    doneWhen: [...(preset.doneWhen ?? [])],
    allow: { ...(onlyOn(preset.allow) ?? {}) },
    figure: null,
  }
}

export function specFromDraft(draft: AgentDraft, note = ''): JobSpec {
  const icon = guessIcon(draft.name, draft.instructions)
  const allow = onlyOn(draft.allow)
  return {
    name: draft.name.trim(),
    ...(draft.does.trim() ? { does: draft.does.trim() } : {}),
    instructions: draft.instructions.trim(),
    ...(icon ? { icon } : {}),
    ...(draft.figure ? { figure: { ...draft.figure } } : {}),
    ...(draft.appId ? { apps: [draft.appId] } : {}),
    ...(draft.appId && draft.model ? { model: draft.model, ...(draft.effort ? { thinkingEffort: draft.effort } : {}) } : {}),
    ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
    ...(draft.tools.length ? { tools: [...draft.tools] } : {}),
    ...(doneWhenOf(draft).length ? { doneWhen: doneWhenOf(draft) } : {}),
    ...(allow ? { allow } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  }
}

const SWITCHES: readonly (keyof AgentAllow)[] = ['web', 'edits', 'commands']

/** The draft's done-when items as they are saved: trimmed, blank lines dropped. */
export function doneWhenOf(draft: Pick<AgentDraft, 'doneWhen'>): string[] {
  return draft.doneWhen.map((item) => item.trim()).filter(Boolean)
}

/** Whether saving `draft` over `saved` would make a new version: something a team copies changed. */
export function makesNewVersion(draft: AgentDraft, saved: AgentDraft): boolean {
  return draft.name.trim() !== saved.name.trim()
    || draft.instructions.trim() !== saved.instructions.trim()
    || draft.appId !== saved.appId
    || (draft.appId ? draft.model : '') !== (saved.appId ? saved.model : '')
    || (draft.appId && draft.model ? draft.effort : '') !== (saved.appId && saved.model ? saved.effort : '')
    || draft.skills.join('\n') !== saved.skills.join('\n')
    || draft.tools.join('\n') !== saved.tools.join('\n')
    || doneWhenOf(draft).join('\n') !== doneWhenOf(saved).join('\n')
    || SWITCHES.some((key) => Boolean(draft.allow[key]) !== Boolean(saved.allow[key]))
}

/** Whether there is anything to save at all, including the palette's line and the figure it wears. */
export function draftChanged(draft: AgentDraft, saved: AgentDraft): boolean {
  return makesNewVersion(draft, saved) || draft.does.trim() !== saved.does.trim()
    || draft.figure?.kind !== saved.figure?.kind || draft.figure?.color !== saved.figure?.color
    || (draft.figure?.wear ?? []).join() !== (saved.figure?.wear ?? []).join()
}

// $defs.Identifier (schemas/team.schema.yaml): ^[A-Za-z0-9][A-Za-z0-9._-]*$
function agentId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

/** The draft as one team agent on `harness`: what its chat runs and the badge describes. */
export function agentFromDraft(draft: AgentDraft, harness: DetectedHarness | null, model = draft.model, link?: { id: string; job?: SavedJob | null }, effort = draft.effort): AgentConfig {
  const allow = onlyOn(draft.allow)
  return {
    id: agentId(draft.name),
    name: draft.name.trim() || 'New agent',
    role: draft.instructions.trim() || DEFAULT_AGENT_ROLE,
    ...(harness ? { spawn: { cmd: harness.spawn.cmd, args: [...harness.spawn.args], env: {}, cwd: '.' } } : {}),
    model,
    ...(effort ? { thinkingEffort: effort } : {}),
    ...(draft.skills.length || draft.tools.length ? { capabilities: capabilitiesOf(draft.skills, draft.tools) } : {}),
    ...(doneWhenOf(draft).length ? { doneWhen: doneWhenOf(draft) } : {}),
    ...(allow ? { allow } : {}),
    ...(link?.job ? { from: { agent: link.id, version: versionOf(link.job) } } : {}),
  }
}

/** The id the agent has in its chat's team: the chat's own, so renaming the agent never changes it. */
export function chatAgentId(chatId: string): string {
  return agentId(chatId)
}

/**
 * An agent's chat (its Chat tab, in Your agents or in a team): this one agent and nothing else, as
 * it is on screen, in the hidden `.jobs/.bench/` folder so the team list and the scheduler never
 * see it. `model` must be one the app advertises. Its agent keeps `chatAgentId(chatId)` whatever it
 * is called, so the chat's history and a note written while it works still reach it after a rename.
 */
export function chatTeamYaml(draft: AgentDraft, harness: DetectedHarness, model: string, chatId: string): string {
  const agent = { ...agentFromDraft(draft, harness, model), id: chatAgentId(chatId) }
  return stringify({ schemaVersion: 1, id: `bench-${chatId}`, name: `${agent.name} · chat`, entrypoint: agent.id, agents: [agent] }, { lineWidth: 0 })
}
