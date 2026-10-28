import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { JobSpec, SavedJob } from '../library/jobs'
import { TeamFileModel } from './document'
import { editedSpec, fillModel, filledAgent, placeInMyAgents, pointerEntry, pointsAt, runsDifferently, settleAgents, specOf, teamOfMyAgents } from './myAgents'
import type { AgentConfig } from './types'

interface Case { name: string; agent: string; entry: Record<string, unknown>; job: JobSpec; filled: Record<string, unknown> }

/** The cases the daemon's twin is tested with too (`my_agents.rs`). */
const cases = JSON.parse(readFileSync(resolve(process.cwd(), '../schemas/my-agents.cases.json'), 'utf8')) as Case[]

describe('a team reads its agents from My agents (ADR 0094)', () => {
  it('fills in a pointer as the daemon does, and leaves an agent written out in full as it is', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const each of cases) {
      const filled = pointsAt(each.entry) ? filledAgent(each.entry, each.agent, each.job) : each.entry
      expect(filled, each.name).toEqual(each.filled)
    }
  })

  it('keeps only the team’s fields in the file, and reads them back to the same agent', () => {
    for (const each of cases.filter((candidate) => pointsAt(candidate.entry))) {
      const pointer = pointerEntry(each.filled, each.agent, each.job)
      for (const key of ['name', 'role', 'doneWhen', 'allow', 'allowRecruiting']) expect(pointer, each.name).not.toHaveProperty(key)
      expect(pointer.from, each.name).toEqual({ agent: each.agent })
      expect(filledAgent(pointer, each.agent, each.job), each.name).toEqual(each.filled)
    }
  })

  it('fills the team document key by key, so its comments stay', () => {
    const model = TeamFileModel.parse('schemaVersion: 1\nentrypoint: lead\n# The lead of this team.\nagents:\n  - id: lead\n    from:\n      agent: researcher\n    # Where it works.\n    spawn:\n      cwd: work\n')
    const job: SavedJob = { id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts.', model: 'fake/offline' }
    const filled = fillModel(model, [job])
    expect(filled.get('lead')?.agent).toBe('researcher')
    expect(model.snapshot().agents[0]).toMatchObject({ name: 'Researcher', role: 'Find facts.', model: 'fake/offline', spawn: { cwd: 'work' } })
    expect(model.toYaml()).toContain('# The lead of this team.')
    expect(model.toYaml()).toContain('# Where it works.')
  })
})

describe('a change made to an agent in a team is saved to the agent', () => {
  const job: JobSpec = { name: 'Writer', instructions: 'Write plainly.', model: 'anthropic/claude-sonnet-5.5', skills: ['cite'], reads: [{ name: 'Style', path: '/style' }] }
  const before = filledAgent({ id: 'writer', from: { agent: 'writer' } }, 'writer', job) as unknown as AgentConfig

  it('moves only what changed here, so a change saved elsewhere meanwhile stays', () => {
    const now: AgentConfig = { ...before, role: 'Write very plainly.' }
    const elsewhere: JobSpec = { ...job, name: 'Copywriter', doneWhen: ['Short sentences.'], allow: { web: true }, skills: ['cite', 'tone'], helpers: false }
    expect(editedSpec(elsewhere, before, now)).toEqual({ ...elsewhere, instructions: 'Write very plainly.' })
  })

  it('keeps a skill wired or taken off on this team’s canvas in this team, and takes a read taken off it to the agent', () => {
    // Wired here: given in this team only, as its file keeps it.
    const wired: AgentConfig = { ...before, capabilities: [...(before.capabilities ?? []), { kind: 'skill', name: 'tone' }] }
    expect(editedSpec(job, before, wired)).toEqual(job)
    // Taken off here: turned off in this team (ADR 0060), still the agent's in every other.
    const taken: AgentConfig = { ...before, capabilities: (before.capabilities ?? []).filter((capability) => capability.kind !== 'skill'), turnedOff: [{ kind: 'skill', name: 'cite' }] }
    expect(editedSpec(job, before, taken).skills).toEqual(['cite'])
    // A read of its own taken off: knowledge isn't turned off for one team, so the agent loses it.
    const unread: AgentConfig = { ...before, capabilities: (before.capabilities ?? []).filter((capability) => capability.kind !== 'knowledge') }
    expect(editedSpec(job, before, unread).reads).toBeUndefined()
  })

  it('takes what the agent may always do with a tool of its own to the agent, and nothing of a tool the team wired', () => {
    const tooled: JobSpec = { ...job, tools: ['Linear'] }
    const read = filledAgent({ id: 'writer', from: { agent: 'writer' }, capabilities: [{ kind: 'tool', name: 'Figma' }] }, 'writer', tooled) as unknown as AgentConfig
    const allowed: AgentConfig = {
      ...read,
      capabilities: (read.capabilities ?? []).map((capability) => capability.kind === 'tool' ? { ...capability, alwaysAllow: ['create'] } : capability),
    }
    const spec = editedSpec(tooled, read, allowed)
    expect(spec.toolAllow).toEqual({ Linear: ['create'] })
    expect(spec.tools).toEqual(['Linear'])
  })

  it('keeps a model the app suggests for this team out of the agent', () => {
    const suggested: AgentConfig = { id: 'editor', name: 'Editor', role: 'Tighten.', model: 'openai/gpt-6.1-mini', followsSuggestion: true }
    const moved: AgentConfig = { ...suggested, model: 'openai/gpt-6.1' }
    expect(editedSpec({ name: 'Editor', instructions: 'Tighten.' }, suggested, moved).model).toBeUndefined()
    expect(specOf(suggested).model).toBeUndefined()
    // A model picked by hand is the agent's.
    expect(editedSpec({ name: 'Editor', instructions: 'Tighten.' }, suggested, { ...moved, followsSuggestion: undefined }).model).toBe('openai/gpt-6.1')
  })
})

describe('saving a team settles each agent into My agents', () => {
  const researcher: SavedJob = { id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts with sources.', model: 'fake/offline', version: 2 }
  const team = (agent: string) => `schemaVersion: 1\nentrypoint: researcher\nagents:\n${agent}edges: []\n`
  const saving = () => vi.fn(async (id: string, spec: JobSpec) => ({ ...spec, id, file: `.jobs/${id}.yaml`, version: 3 }) as SavedJob)

  it('lets a copy from before the move give way to the agent as it is, pushing nothing of the copy into it', async () => {
    const model = TeamFileModel.parse(team('  - id: researcher\n    name: Researcher\n    role: An older copy.\n    model: fake/offline\n    from: {agent: researcher, version: 1}\n'))
    const filled = fillModel(model, [researcher])
    const save = saving()
    await settleAgents(model, [researcher], filled, 'Blog', save)
    expect(save).not.toHaveBeenCalled()
    expect(model.snapshot().agents[0]).toMatchObject({ role: 'Find facts with sources.', from: { agent: 'researcher' } })
  })

  it('takes what was changed on a copy since it was read to the agent', async () => {
    const model = TeamFileModel.parse(team('  - id: researcher\n    name: Researcher\n    role: An older copy.\n    model: fake/offline\n    from: {agent: researcher, version: 1}\n'))
    const filled = fillModel(model, [researcher])
    model.setAgentField('researcher', 'name', 'Fact finder')
    const save = saving()
    await settleAgents(model, [researcher], filled, 'Blog', save)
    expect(save).toHaveBeenCalledWith('researcher', { ...researcher, name: 'Fact finder' }, { replace: true, expectedVersion: 2 })
  })

  it('takes an edit made to an agent just added from My agents to the agent', async () => {
    // Added from the palette after the team was read: a copy with no baseline of its own.
    const model = TeamFileModel.parse(team('  - id: researcher\n    name: Researcher\n    role: Find facts with sources, and say how sure you are.\n    model: fake/offline\n    from: {agent: researcher, version: 2}\n'))
    const save = saving()
    await settleAgents(model, [researcher], new Map(), 'Blog', save)
    expect(save).toHaveBeenCalledWith('researcher', { ...researcher, instructions: 'Find facts with sources, and say how sure you are.' }, { replace: true, expectedVersion: 2 })
  })
})

describe('a new team is made of My agents', () => {
  const researcher: SavedJob = { id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts with sources.', model: 'fake/offline', version: 2 }
  const saving = () => vi.fn(async (id: string, spec: JobSpec) => ({ ...spec, id, file: `.jobs/${id}.yaml`, version: 1 }) as SavedJob)

  it('points at one picked from My agents, and makes a built-in one an agent there first', async () => {
    const yaml = 'schemaVersion: 1\nid: blog\nname: Blog\nentrypoint: researcher\nagents:\n  - id: researcher\n    name: Researcher\n    role: Find facts with sources.\n    model: fake/offline\n    from: {agent: researcher, version: 2}\n  - id: writer\n    name: Writer\n    role: Write the post.\n    model: fake/offline\nedges: []\n'
    const save = saving()
    const written = TeamFileModel.parse(await teamOfMyAgents(yaml, [researcher], save)).snapshot()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('writer', { name: 'Writer', instructions: 'Write the post.', model: 'fake/offline' })
    expect(written.agents).toEqual([{ id: 'researcher', from: { agent: 'researcher' } }, { id: 'writer', from: { agent: 'writer' } }])
  })

  it('keeps the folder a new agent was given, and its part, in the team (ADR 0097)', async () => {
    const yaml = 'schemaVersion: 1\nid: sutd\nname: SUTD final project\nentrypoint: researcher\nagents:\n  - id: researcher\n    name: Researcher\n    role: Find facts with sources.\n    model: fake/offline\n    doneWhen: [Every claim has a source]\n    part:\n      text: Find two or three options for the gate.\n      doneWhen: [Gives each option its trade-offs]\n    capabilities:\n      - {kind: knowledge, name: SUTD project, path: /Users/me/SUTD}\n      - {kind: skill, name: cite}\nedges: []\n'
    const save = saving()
    const written = TeamFileModel.parse(await teamOfMyAgents(yaml, [], save)).snapshot()
    expect(save).toHaveBeenCalledWith('researcher', { name: 'Researcher', instructions: 'Find facts with sources.', model: 'fake/offline', skills: ['cite'], doneWhen: ['Every claim has a source'] })
    expect(written.agents).toEqual([{
      id: 'researcher',
      part: { text: 'Find two or three options for the gate.', doneWhen: ['Gives each option its trade-offs'] },
      capabilities: [{ kind: 'knowledge', name: 'SUTD project', path: '/Users/me/SUTD' }],
      from: { agent: 'researcher' },
    }])
  })
})

describe('the move says which agents run differently', () => {
  const copy: AgentConfig = { id: 'researcher', name: 'Researcher', role: 'Find facts.', model: 'fake/offline', capabilities: [{ kind: 'knowledge', name: 'Notes', path: '/notes' }] }

  it('tells a change in what it runs from a new label', () => {
    expect(runsDifferently(copy, { ...copy, capabilities: [{ kind: 'knowledge', name: 'Notes (2)', path: '/notes' }] })).toBe(false)
    expect(runsDifferently(copy, { ...copy, role: 'Find facts with sources.' })).toBe(true)
    expect(runsDifferently(copy, { ...copy, model: 'anthropic/claude-opus-5.5' })).toBe(true)
    expect(runsDifferently(copy, { ...copy, capabilities: [...(copy.capabilities ?? []), { kind: 'skill', name: 'cite' }] })).toBe(true)
  })
})

describe('a team’s own agent becomes one of My agents', () => {
  const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write plainly.' }

  it('joins the agent already there when it is exactly the same', () => {
    expect(placeInMyAgents({ name: 'Writer', instructions: 'Write plainly.' }, [writer], 'Market brief')).toMatchObject({ id: 'writer', existing: true })
  })

  it('takes its team’s name after its own when another agent has the name', () => {
    expect(placeInMyAgents({ name: 'Writer', instructions: 'Write for investors.' }, [writer], 'Market brief')).toEqual({
      id: 'writer-market-brief',
      spec: { name: 'Writer · Market brief', instructions: 'Write for investors.' },
      existing: false,
    })
    expect(placeInMyAgents({ name: 'Analyst', instructions: 'Compare.' }, [writer], 'Market brief')).toMatchObject({ id: 'analyst', existing: false })
  })
})
