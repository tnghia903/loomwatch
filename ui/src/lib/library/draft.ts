import { stringify } from 'yaml'

import { DEFAULT_MODEL } from '../ai/modelIds'
import type { AgentAllow, AgentConfig, CapabilityRef } from '../team-file/types'
import { DEFAULT_AGENT_ROLE } from './createAgent'
import { isFigureChoice, type FigureChoice } from './figures'
import { guessIcon, onlyOn, versionOf, type JobSpec, type SavedJob } from './jobs'
import { capabilitiesOf, modelForPreset, type RolePreset } from './roles'
import { keptFor, sameAllow, type ToolAllow } from '../tools/allow'
import { NEW_TEAM_PER_RUN_USD } from '../runs/spend'

/**
 * The agent builder's working copy of one of Your agents: what is on screen, saved or not. Saving
 * turns it into a job spec (`specFromDraft`); its chat turns it into a one-agent team
 * (`chatTeamYaml`), so working with an agent never needs it saved first.
 */
export interface AgentDraft {
  name: string
  does: string
  instructions: string
  /** The OpenRouter model it runs on. */
  model: string
  /** How hard that model thinks; empty means the model's own default. */
  effort: string
  skills: string[]
  /** The tools it is given, by name. A team copies them like its skills, and its Workflow canvas
      draws each as a card wired to it. */
  tools: string[]
  /** Calls of those tools it may make without asking, by tool name (ADR 0069). Every other call
      asks you first. */
  toolAllow: ToolAllow
  /** What the finished result must satisfy (ADR 0062); empty when nothing is set. */
  doneWhen: string[]
  allow: AgentAllow
  /** The figure it wears in Your agents; `null` wears the one its id picks. A team never copies it. */
  figure: FigureChoice | null
}

export const BLANK_DRAFT: AgentDraft = { name: '', does: '', instructions: DEFAULT_AGENT_ROLE, model: DEFAULT_MODEL, effort: '', skills: [], tools: [], toolAllow: {}, doneWhen: [], allow: {}, figure: null }

export function draftFromJob(job: JobSpec): AgentDraft {
  return {
    name: job.name,
    does: job.does ?? '',
    instructions: job.instructions,
    model: job.model || DEFAULT_MODEL,
    effort: job.model ? job.thinkingEffort ?? '' : '',
    skills: [...(job.skills ?? [])],
    tools: [...(job.tools ?? [])],
    toolAllow: keptFor(job.toolAllow ?? {}, job.tools ?? []),
    doneWhen: [...(job.doneWhen ?? [])],
    allow: { ...(onlyOn(job.allow) ?? {}) },
    figure: isFigureChoice(job.figure) ? { ...job.figure } : null,
  }
}

/** A built-in job as a new agent's starting point, on the model its kind of work suits. */
export function draftFromPreset(preset: RolePreset): AgentDraft {
  const choice = modelForPreset(preset)
  return {
    name: preset.label,
    does: preset.does,
    instructions: preset.role,
    model: choice.model,
    effort: choice.thinkingEffort ?? '',
    skills: [...(preset.skills ?? [])],
    tools: [...(preset.tools ?? [])],
    toolAllow: {},
    doneWhen: [...(preset.doneWhen ?? [])],
    allow: { ...(onlyOn(preset.allow) ?? {}) },
    figure: null,
  }
}

export function specFromDraft(draft: AgentDraft, note = ''): JobSpec {
  const icon = guessIcon(draft.name, draft.instructions)
  const allow = onlyOn(draft.allow)
  const toolAllow = keptFor(draft.toolAllow, draft.tools)
  return {
    name: draft.name.trim(),
    ...(draft.does.trim() ? { does: draft.does.trim() } : {}),
    instructions: draft.instructions.trim(),
    ...(icon ? { icon } : {}),
    ...(draft.figure ? { figure: { ...draft.figure } } : {}),
    ...(draft.model ? { model: draft.model, ...(draft.effort ? { thinkingEffort: draft.effort } : {}) } : {}),
    ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
    ...(draft.tools.length ? { tools: [...draft.tools] } : {}),
    ...(Object.keys(toolAllow).length ? { toolAllow } : {}),
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
    || draft.model !== saved.model
    || draft.effort !== saved.effort
    || draft.skills.join('\n') !== saved.skills.join('\n')
    || draft.tools.join('\n') !== saved.tools.join('\n')
    || !sameAllow(draft.toolAllow, saved.toolAllow, draft.tools)
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

/** The draft as one team agent: what its chat runs and the badge describes. */
export function agentFromDraft(draft: AgentDraft, model = draft.model, link?: { id: string; job?: SavedJob | null }, effort = draft.effort): AgentConfig {
  const allow = onlyOn(draft.allow)
  return {
    id: agentId(draft.name),
    name: draft.name.trim() || 'New agent',
    role: draft.instructions.trim() || DEFAULT_AGENT_ROLE,
    model: model || DEFAULT_MODEL,
    ...(effort ? { thinkingEffort: effort } : {}),
    ...(draft.skills.length || draft.tools.length ? { capabilities: capabilitiesOf(draft.skills, draft.tools, draft.toolAllow) } : {}),
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
 * see it. Its agent keeps `chatAgentId(chatId)` whatever it
 * is called, so the chat's history and a note written while it works still reach it after a rename.
 * Inside a team it also reads what the team gives it (`knowledge`, from `knowledgeForChat`).
 */
export function chatTeamYaml(draft: AgentDraft, model: string, chatId: string, knowledge: readonly CapabilityRef[] = []): string {
  const own = agentFromDraft(draft, model)
  const capabilities = [...knowledge, ...(own.capabilities ?? [])]
  const agent = { ...own, id: chatAgentId(chatId), ...(capabilities.length ? { capabilities } : {}) }
  return stringify({ schemaVersion: 1, id: `bench-${chatId}`, name: `${agent.name} · chat`, spend: { perRun: NEW_TEAM_PER_RUN_USD }, entrypoint: agent.id, agents: [agent] }, { lineWidth: 0 })
}
