import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { DEFAULT_MODEL, setConnectedSources } from '../ai/modelIds'
import { agentFromDraft, BLANK_DRAFT, blankDraft, chatAgentId, chatTeamYaml, draftChanged, draftFromJob, draftFromPreset, makesNewVersion, specFromDraft } from './draft'
import { buildAgentFromSource } from './createAgent'
import { savedJobPreset } from './jobs'
import { ROLE_PRESETS, roleSource } from './roles'
import { draftFromTeamAgent, teamAgentEdit } from './teamDraft'

describe('the agent builder’s draft', () => {
  it('starts a blank agent on a model what is connected now can run (ADR 0073)', () => {
    try {
      setConnectedSources(['anthropic'])
      expect(blankDraft().model).toBe('anthropic:claude-opus-5-5')
      setConnectedSources(['chatgpt'])
      expect(blankDraft().model).toBe('chatgpt:gpt-6.1-sol')
      setConnectedSources([])
      expect(blankDraft().model).toBe(DEFAULT_MODEL)
    } finally {
      setConnectedSources([])
    }
  })

  it('saves what it shows and reads back the same', () => {
    const draft = { name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', model: 'sonnet', effort: '', skills: ['source-check'], tools: ['github'], toolAllow: {}, reads: [], doneWhen: [], allow: { web: true, edits: false }, figure: { kind: 'button' as const, color: 'sage' as const } }
    const spec = specFromDraft(draft, 'First cut')
    expect(spec).toEqual({ name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', icon: 'review', figure: { kind: 'button', color: 'sage' }, model: 'sonnet', skills: ['source-check'], tools: ['github'], allow: { web: true }, note: 'First cut' })
    expect(draftFromJob(spec)).toEqual({ ...draft, allow: { web: true } })
  })

  it('saves a tool’s always-allowed calls only for tools it is given, and a team copies them (ADR 0069)', () => {
    const draft = { ...BLANK_DRAFT, name: 'Triager', tools: ['Linear'], toolAllow: { linear: ['create_issue', 'create_issue'], Gone: ['x'] } }
    expect(specFromDraft(draft).toolAllow).toEqual({ Linear: ['create_issue'] })
    expect(agentFromDraft(draft).capabilities).toEqual([{ kind: 'tool', name: 'Linear', alwaysAllow: ['create_issue'] }])
    const saved = draftFromJob(specFromDraft(draft))
    expect(saved.toolAllow).toEqual({ Linear: ['create_issue'] })
    expect(makesNewVersion({ ...saved, toolAllow: {} }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, toolAllow: { LINEAR: ['create_issue'] } }, saved)).toBe(false)
  })

  it('makes a new version only for what a team copies', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.' })
    expect(makesNewVersion({ ...saved, does: 'Checks stories' }, saved)).toBe(false)
    expect(draftChanged({ ...saved, does: 'Checks stories' }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, allow: { commands: true } }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, skills: ['a'] }, saved)).toBe(true)
    // A team copies its tools too, so giving it one is a new version.
    expect(makesNewVersion({ ...saved, tools: ['github'] }, saved)).toBe(true)
    // Its figure is only how it looks in Your agents: worth saving, never a new version.
    const dressed = { ...saved, figure: { kind: 'spool' as const, color: 'sky' as const } }
    expect(makesNewVersion(dressed, saved)).toBe(false)
    expect(draftChanged(dressed, saved)).toBe(true)
    expect(draftChanged({ ...dressed, figure: { kind: 'spool' as const, color: 'rose' as const } }, dressed)).toBe(true)
    expect(draftChanged({ ...dressed }, dressed)).toBe(false)
  })

  it('reads a figure it does not know as none, so it wears the one its id picks', () => {
    expect(draftFromJob({ name: 'Reader', instructions: 'Check.', figure: { kind: 'robot', color: 'sage' } as never }).figure).toBeNull()
    expect(specFromDraft(draftFromJob({ name: 'Reader', instructions: 'Check.' }))).not.toHaveProperty('figure')
  })

  it('keeps a thinking effort with its model, and a new one is a new version', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', model: 'anthropic/claude-sonnet-5.5', thinkingEffort: 'high' })
    expect(saved.effort).toBe('high')
    expect(specFromDraft(saved)).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', thinkingEffort: 'high' })
    expect(makesNewVersion({ ...saved, effort: 'low' }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, model: DEFAULT_MODEL }, saved)).toBe(true)
    // With no model of its own, there is no effort to keep: efforts belong to one model.
    expect(specFromDraft({ ...saved, model: '' })).not.toHaveProperty('thinkingEffort')
    // A job that names no model starts as a new agent does, at the table's effort, not its own.
    expect(draftFromJob({ name: 'Reader', instructions: 'Check.', thinkingEffort: 'high' })).toMatchObject({ model: DEFAULT_MODEL, effort: 'medium' })
  })

  // ADR 0062: done-when travels with the agent: saved, a new version when it changes, copied
  // into the bench team, and started from a built-in job's own items.
  it('brings in helpers unless switched off, which is saved, versioned, chatted with and copied into a team (ADR 0079)', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.' })
    expect(saved.helpers).toBeUndefined()
    expect(specFromDraft(saved)).not.toHaveProperty('helpers')
    expect(agentFromDraft(saved)).not.toHaveProperty('allowRecruiting')
    const alone = { ...saved, helpers: false as const }
    expect(makesNewVersion(alone, saved)).toBe(true)
    expect(makesNewVersion({ ...alone, helpers: undefined }, saved)).toBe(false)
    expect(specFromDraft(alone)).toMatchObject({ helpers: false })
    expect(draftFromJob(specFromDraft(alone)).helpers).toBe(false)
    const team = parse(chatTeamYaml(alone, 'sonnet', 'reader')) as { agents: Record<string, unknown>[] }
    expect(team.agents[0]).toMatchObject({ allowRecruiting: false })
    const placed = buildAgentFromSource(roleSource(savedJobPreset({ id: 'reader', file: 'reader.yaml', ...specFromDraft(alone) })), [])
    expect(placed.allowRecruiting).toBe(false)
    expect(buildAgentFromSource(roleSource(savedJobPreset({ id: 'reader', file: 'reader.yaml', ...specFromDraft(saved) })), []).allowRecruiting).toBe(true)
    expect(teamAgentEdit(placed, 'helpers', undefined)).toEqual({ kind: 'fields', fields: { allowRecruiting: true } })
    expect(draftFromTeamAgent(placed).helpers).toBe(false)
  })

  it('saves done-when trimmed, versions it, and chats with it', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', doneWhen: ['Every story has a link'] })
    expect(saved.doneWhen).toEqual(['Every story has a link'])
    expect(makesNewVersion({ ...saved, doneWhen: ['Every story has a link', 'Five stories'] }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, doneWhen: ['Every story has a link', '  '] }, saved)).toBe(false)
    expect(specFromDraft({ ...saved, doneWhen: ['  Five stories ', ''] })).toMatchObject({ doneWhen: ['Five stories'] })
    expect(specFromDraft({ ...saved, doneWhen: [' '] })).not.toHaveProperty('doneWhen')
    const team = parse(chatTeamYaml(saved, 'sonnet', 'reader')) as { agents: Record<string, unknown>[] }
    expect(team.agents[0]).toMatchObject({ doneWhen: ['Every story has a link'] })
    const writer = ROLE_PRESETS.find((preset) => preset.id === 'writer')!
    expect(draftFromPreset(writer).doneWhen).toEqual([...(writer.doneWhen ?? [])])
  })

  it('starts a new agent from a built-in job on its job’s model, at its job’s effort', () => {
    const researcher = ROLE_PRESETS.find((preset) => preset.id === 'researcher')!
    const draft = draftFromPreset(researcher)
    expect(draft).toMatchObject({ name: 'Researcher', model: DEFAULT_MODEL, effort: 'medium', instructions: researcher.role })
    expect(draft.allow.web).toBe(true)
  })

  it('chats with it at its thinking effort', () => {
    const draft = { name: 'Reader', does: '', instructions: 'Check.', model: 'opus', effort: 'max', skills: [], tools: [], toolAllow: {}, reads: [], doneWhen: [], allow: {}, figure: null }
    const team = parse(chatTeamYaml(draft, 'opus', 'reader')) as { agents: Record<string, unknown>[] }
    expect(team.agents[0]).toMatchObject({ model: 'opus', thinkingEffort: 'max' })
  })

  it('chats with it as a team of one, on its model, in the team file’s own folder', () => {
    const draft = { name: 'Release notes writer', does: '', instructions: 'Write the notes.', model: '', effort: '', skills: ['house-style'], tools: ['github'], toolAllow: {}, reads: [], doneWhen: [], allow: { web: true }, figure: null }
    const team = parse(chatTeamYaml(draft, 'anthropic/claude-sonnet-5.5', 'release-notes-writer')) as Record<string, unknown>
    expect(team).toEqual({
      schemaVersion: 1,
      id: 'bench-release-notes-writer',
      name: 'Release notes writer · chat',
      // A run spends real money, so a chat with an agent has the same $1.00 a new team has (ADR 0068).
      spend: { perRun: 1 },
      entrypoint: 'release-notes-writer',
      agents: [{
        id: 'release-notes-writer', name: 'Release notes writer', role: 'Write the notes.',
        model: 'anthropic/claude-sonnet-5.5',
        // Its tools go with it, so its chat uses them as a team would.
        capabilities: [{ kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'github' }], allow: { web: true },
      }],
    })
  })

  it('chats inside a team with what the team gives it to read, beside its own skills and tools', () => {
    const draft = { name: 'Researcher', does: '', instructions: 'Find sources.', model: '', effort: '', skills: ['source-check'], tools: ['github'], toolAllow: {}, reads: [], doneWhen: [], allow: {}, figure: null }
    const knowledge = [{ kind: 'knowledge' as const, name: 'notes', path: '/Users/me/notes' }, { kind: 'knowledge' as const, name: 'Hub', notion: { page: 'abc' } }]
    const team = parse(chatTeamYaml(draft, 'sonnet', 'researcher', knowledge)) as { agents: Record<string, unknown>[] }
    expect(team.agents[0].capabilities).toEqual([...knowledge, { kind: 'skill', name: 'source-check' }, { kind: 'tool', name: 'github' }])
    const bare = parse(chatTeamYaml({ ...draft, skills: [], tools: [] }, 'sonnet', 'researcher', knowledge)) as typeof team
    expect(bare.agents[0].capabilities).toEqual(knowledge)
    // Given nothing to read in Your agents, its chat reads nothing.
    expect(parse(chatTeamYaml({ ...draft, skills: [], tools: [] }, 'sonnet', 'researcher'))).not.toHaveProperty('agents.0.capabilities')
  })

  it('reads in its chat what it reads in every team, and each folder, file or page once', () => {
    const reads = [{ name: 'Brand', path: '/Users/me/brand' }, { name: 'Roadmap', notion: { page: 'ABC-1' } }]
    const draft = { ...BLANK_DRAFT, name: 'Writer', instructions: 'Write.', reads }
    const own = parse(chatTeamYaml(draft, 'sonnet', 'writer')) as { agents: Record<string, unknown>[] }
    expect(own.agents[0].capabilities).toEqual([{ kind: 'knowledge', name: 'Brand', path: '/Users/me/brand' }, { kind: 'knowledge', name: 'Roadmap', notion: { page: 'ABC-1' } }])
    // In a team that copied them, and gives it one more, each is read once.
    const knowledge = [{ kind: 'knowledge' as const, name: 'Brand', path: '/Users/me/brand' }, { kind: 'knowledge' as const, name: 'Road map', notion: { page: 'abc1' } }, { kind: 'knowledge' as const, name: 'notes', path: 'team.files/notes.md' }]
    const inTeam = parse(chatTeamYaml(draft, 'sonnet', 'writer', knowledge)) as typeof own
    expect(inTeam.agents[0].capabilities).toEqual(knowledge)
  })

  it('saves what it reads, and a change to it is a new version', () => {
    const draft = { ...BLANK_DRAFT, name: 'Writer', instructions: 'Write.', reads: [{ name: 'Brand', path: '/Users/me/brand' }] }
    const spec = specFromDraft(draft)
    expect(spec.reads).toEqual([{ name: 'Brand', path: '/Users/me/brand' }])
    expect(specFromDraft({ ...draft, reads: [] })).not.toHaveProperty('reads')
    const saved = draftFromJob(spec)
    expect(saved.reads).toEqual(draft.reads)
    expect(makesNewVersion({ ...saved, reads: [] }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, reads: [{ name: 'Brand', path: '/Users/me/other' }] }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, reads: [{ name: 'Brand', path: '/Users/me/brand' }] }, saved)).toBe(false)
    // A built-in job starts reading nothing.
    expect(draftFromPreset(ROLE_PRESETS[0]).reads).toEqual([])
  })

  it('keeps its chat’s agent under the chat’s id, whatever the agent is called', () => {
    const draft = { name: 'Release notes writer', does: '', instructions: 'Write the notes.', model: '', effort: '', skills: [], tools: [], toolAllow: {}, reads: [], doneWhen: [], allow: {}, figure: null }
    const before = parse(chatTeamYaml(draft, 'sonnet', 'notes')) as { id: string; name: string; entrypoint: string; agents: { id: string; name: string }[] }
    const renamed = parse(chatTeamYaml({ ...draft, name: 'Changelog writer' }, 'sonnet', 'notes')) as typeof before
    expect(before).toMatchObject({ id: 'bench-notes', name: 'Release notes writer · chat', entrypoint: 'notes', agents: [{ id: 'notes', name: 'Release notes writer' }] })
    // The same file, and the same agent in it: its history and a note for its turn still find it.
    expect(renamed).toMatchObject({ id: 'bench-notes', entrypoint: 'notes', agents: [{ id: 'notes', name: 'Changelog writer' }] })
    expect(chatAgentId('notes')).toBe('notes')
  })
})
