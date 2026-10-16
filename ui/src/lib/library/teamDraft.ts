import type { DetectedHarness } from '../harnesses'
import { chosenIsFile, chosenName } from '../knowledge/chosen'
import { harnessIdForAgent } from '../models'
import type { AgentConfig } from '../team-file/types'
import type { AgentDraft } from './draft'
import type { ReadSource } from './figure'
import { onlyOn } from './jobs'

/**
 * A team's own agent on the workbench (the team's Agents tab). The workbench edits an
 * `AgentDraft`; for an agent that is the team's own, that draft is read from the team file and
 * every change is written straight back to it, so it is saved with the team like a canvas edit.
 * (An agent placed from Your agents is edited there instead, as its next version.)
 */
export function draftFromTeamAgent(agent: AgentConfig, harnesses: readonly DetectedHarness[]): AgentDraft {
  return {
    name: agent.name,
    // A team agent has no palette line: that belongs to Your agents.
    does: '',
    instructions: agent.role,
    appId: harnessIdForAgent(agent, harnesses),
    model: agent.model ?? '',
    effort: agent.thinkingEffort ?? '',
    skills: (agent.capabilities ?? []).filter((capability) => capability.kind === 'skill').map((capability) => capability.name),
    doneWhen: [...(agent.doneWhen ?? [])],
    allow: { ...(agent.allow ?? {}) },
    // A team's own agent wears the figure its id picks: the figure belongs to Your agents.
    figure: null,
  }
}

/**
 * What a team's agent reads, for the drawer in its bench: each folder, file and Notion page
 * the team gives it with a line on the canvas (ADR 0042, 0050), in the team file's order. The same
 * for a linked agent, since what it reads stays the team's own. Knowledge without a path or page
 * names nothing it can read (ADR 0036), so it isn't shown as something it reads.
 */
export function readsOf(agent: Pick<AgentConfig, 'capabilities'>): ReadSource[] {
  return (agent.capabilities ?? []).flatMap((capability): ReadSource[] => {
    if (capability.kind !== 'knowledge') return []
    if (capability.notion) return [{ kind: 'page', name: capability.name, where: 'Notion page · read when each run starts' }]
    if (!capability.path) return []
    return [{ kind: chosenIsFile(capability.path) ? 'file' : 'folder', name: capability.name || chosenName(capability.path), where: capability.path }]
  })
}

/**
 * The tools (MCP servers) a team's agent is given with a line on the canvas, for the tool drawer
 * in its bench: each named once, in the team file's order. Like what it reads, the team's own for a
 * linked agent too.
 */
export function toolsOf(agent: Pick<AgentConfig, 'capabilities'>): string[] {
  const names = (agent.capabilities ?? []).flatMap((capability) => (capability.kind === 'tool' && capability.name.trim() ? [capability.name.trim()] : []))
  return [...new Set(names)]
}

/** What one workbench change does to the team file. */
export type TeamAgentEdit =
  | { kind: 'rename'; field: 'name' | 'role'; value: string }
  | { kind: 'fields'; fields: Partial<Pick<AgentConfig, 'model' | 'thinkingEffort' | 'spawn' | 'capabilities' | 'allow' | 'doneWhen'>> }

/** The team-file change for setting `key` to `value` on the workbench, or `null` when there is none. */
export function teamAgentEdit<K extends keyof AgentDraft>(agent: AgentConfig, key: K, value: AgentDraft[K], harnesses: readonly DetectedHarness[]): TeamAgentEdit | null {
  switch (key) {
    case 'name': return { kind: 'rename', field: 'name', value: value as string }
    case 'instructions': return { kind: 'rename', field: 'role', value: value as string }
    case 'appId': {
      const harness = harnesses.find((candidate) => candidate.id === value)
      if (!harness) return null
      // A new app: its own command, and the model and effort go back to that app's defaults.
      return { kind: 'fields', fields: { spawn: { env: {}, cwd: '.', ...agent.spawn, cmd: harness.spawn.cmd, args: [...harness.spawn.args] }, model: '', thinkingEffort: undefined } }
    }
    case 'model': return { kind: 'fields', fields: { model: value as string } }
    case 'effort': return { kind: 'fields', fields: { thinkingEffort: (value as string) || undefined } }
    case 'skills': {
      // Its folders, files and tools stay; only the skills are the workbench's to change.
      const others = (agent.capabilities ?? []).filter((capability) => capability.kind !== 'skill')
      const capabilities = [...others, ...(value as string[]).map((name) => ({ kind: 'skill' as const, name }))]
      return { kind: 'fields', fields: { capabilities: capabilities.length ? capabilities : undefined } }
    }
    case 'allow': return { kind: 'fields', fields: { allow: onlyOn(value as AgentDraft['allow']) } }
    case 'doneWhen': {
      // Blank lines are kept while the operator types; only written items reach the file.
      const items = (value as string[]).map((item) => item.trim()).filter(Boolean)
      return { kind: 'fields', fields: { doneWhen: items.length ? items : undefined } }
    }
    default: return null
  }
}
