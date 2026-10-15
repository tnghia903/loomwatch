import { stringify } from 'yaml'

import type { DetectedHarness } from '../harnesses'
import type { AgentAllow, AgentConfig } from '../team-file/types'
import { DEFAULT_AGENT_ROLE } from './createAgent'
import { guessIcon, onlyOn, versionOf, type JobSpec, type SavedJob } from './jobs'
import { harnessForRole, type RolePreset } from './roles'

/**
 * The agent builder's working copy of one of Your agents: what is on screen, saved or not. Saving
 * turns it into a job spec (`specFromDraft`); the test bench turns it into a one-agent team
 * (`benchTeamYaml`), so trying an agent never needs it saved first.
 */
export interface AgentDraft {
  name: string
  does: string
  instructions: string
  /** The app it runs on; `null` until one is chosen. */
  appId: string | null
  /** A model id of `appId`; empty means the app's own current model. */
  model: string
  skills: string[]
  allow: AgentAllow
}

export const BLANK_DRAFT: AgentDraft = { name: '', does: '', instructions: DEFAULT_AGENT_ROLE, appId: null, model: '', skills: [], allow: {} }

export function draftFromJob(job: JobSpec): AgentDraft {
  return {
    name: job.name,
    does: job.does ?? '',
    instructions: job.instructions,
    appId: job.apps?.[0] ?? null,
    model: job.apps?.length ? job.model ?? '' : '',
    skills: [...(job.skills ?? [])],
    allow: { ...(onlyOn(job.allow) ?? {}) },
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
    skills: [...(preset.skills ?? [])],
    allow: { ...(onlyOn(preset.allow) ?? {}) },
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
    ...(draft.appId ? { apps: [draft.appId] } : {}),
    ...(draft.appId && draft.model ? { model: draft.model } : {}),
    ...(draft.skills.length ? { skills: [...draft.skills] } : {}),
    ...(allow ? { allow } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  }
}

const SWITCHES: readonly (keyof AgentAllow)[] = ['web', 'edits', 'commands']

/** Whether saving `draft` over `saved` would make a new version: something a team copies changed. */
export function makesNewVersion(draft: AgentDraft, saved: AgentDraft): boolean {
  return draft.name.trim() !== saved.name.trim()
    || draft.instructions.trim() !== saved.instructions.trim()
    || draft.appId !== saved.appId
    || (draft.appId ? draft.model : '') !== (saved.appId ? saved.model : '')
    || draft.skills.join('\n') !== saved.skills.join('\n')
    || SWITCHES.some((key) => Boolean(draft.allow[key]) !== Boolean(saved.allow[key]))
}

/** Whether there is anything to save at all, including the palette's line. */
export function draftChanged(draft: AgentDraft, saved: AgentDraft): boolean {
  return makesNewVersion(draft, saved) || draft.does.trim() !== saved.does.trim()
}

// $defs.Identifier (schemas/team.schema.yaml): ^[A-Za-z0-9][A-Za-z0-9._-]*$
function agentId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

/** The draft as one team agent on `harness`: what the test bench runs and the badge describes. */
export function agentFromDraft(draft: AgentDraft, harness: DetectedHarness | null, model = draft.model, link?: { id: string; job?: SavedJob | null }): AgentConfig {
  const allow = onlyOn(draft.allow)
  return {
    id: agentId(draft.name),
    name: draft.name.trim() || 'New agent',
    role: draft.instructions.trim() || DEFAULT_AGENT_ROLE,
    ...(harness ? { spawn: { cmd: harness.spawn.cmd, args: [...harness.spawn.args], env: {}, cwd: '.' } } : {}),
    model,
    ...(draft.skills.length ? { capabilities: draft.skills.map((name) => ({ kind: 'skill' as const, name })) } : {}),
    ...(allow ? { allow } : {}),
    ...(link?.job ? { from: { agent: link.id, version: versionOf(link.job) } } : {}),
  }
}

/**
 * The test bench's team: this one agent and nothing else, in the hidden `.jobs/.bench/` folder so
 * the team list and the scheduler never see it. `model` must be one the app advertises.
 */
export function benchTeamYaml(draft: AgentDraft, harness: DetectedHarness, model: string, benchId: string): string {
  const agent = agentFromDraft(draft, harness, model)
  return stringify({ schemaVersion: 1, id: `bench-${benchId}`, name: `${agent.name} · test bench`, entrypoint: agent.id, agents: [agent] }, { lineWidth: 0 })
}
