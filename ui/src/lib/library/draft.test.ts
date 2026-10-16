import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from '../harnesses'
import { chatAgentId, chatTeamYaml, draftChanged, draftFromJob, draftFromPreset, makesNewVersion, specFromDraft } from './draft'
import { ROLE_PRESETS } from './roles'

const claude: DetectedHarness = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', executablePath: '/bin/claude-agent-acp', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }

describe('the agent builder’s draft', () => {
  it('saves what it shows and reads back the same', () => {
    const draft = { name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', appId: 'claude', model: 'sonnet', effort: '', skills: ['source-check'], tools: ['github'], doneWhen: [], allow: { web: true, edits: false }, figure: { kind: 'button' as const, color: 'sage' as const } }
    const spec = specFromDraft(draft, 'First cut')
    expect(spec).toEqual({ name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', icon: 'review', figure: { kind: 'button', color: 'sage' }, apps: ['claude'], model: 'sonnet', skills: ['source-check'], tools: ['github'], allow: { web: true }, note: 'First cut' })
    expect(draftFromJob(spec)).toEqual({ ...draft, allow: { web: true } })
  })

  it('makes a new version only for what a team copies', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', apps: ['claude'] })
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
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', apps: ['claude'], model: 'sonnet', thinkingEffort: 'high' })
    expect(saved.effort).toBe('high')
    expect(specFromDraft(saved)).toMatchObject({ model: 'sonnet', thinkingEffort: 'high' })
    expect(makesNewVersion({ ...saved, effort: 'low' }, saved)).toBe(true)
    // With no model of its own, there is no effort to keep: efforts belong to one model.
    expect(specFromDraft({ ...saved, model: '' })).not.toHaveProperty('thinkingEffort')
    expect(draftFromJob({ name: 'Reader', instructions: 'Check.', apps: ['claude'], thinkingEffort: 'high' }).effort).toBe('')
  })

  // ADR 0062: done-when travels with the agent: saved, a new version when it changes, copied
  // into the bench team, and started from a built-in job's own items.
  it('saves done-when trimmed, versions it, and chats with it', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', apps: ['claude'], doneWhen: ['Every story has a link'] })
    expect(saved.doneWhen).toEqual(['Every story has a link'])
    expect(makesNewVersion({ ...saved, doneWhen: ['Every story has a link', 'Five stories'] }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, doneWhen: ['Every story has a link', '  '] }, saved)).toBe(false)
    expect(specFromDraft({ ...saved, doneWhen: ['  Five stories ', ''] })).toMatchObject({ doneWhen: ['Five stories'] })
    expect(specFromDraft({ ...saved, doneWhen: [' '] })).not.toHaveProperty('doneWhen')
    const team = parse(chatTeamYaml(saved, claude, 'sonnet', 'reader')) as { agents: Record<string, unknown>[] }
    expect(team.agents[0]).toMatchObject({ doneWhen: ['Every story has a link'] })
    const writer = ROLE_PRESETS.find((preset) => preset.id === 'writer')!
    expect(draftFromPreset(writer, [claude]).doneWhen).toEqual([...(writer.doneWhen ?? [])])
  })

  it('starts a new agent from a built-in job on the app that job prefers', () => {
    const researcher = ROLE_PRESETS.find((preset) => preset.id === 'researcher')!
    const draft = draftFromPreset(researcher, [claude])
    expect(draft).toMatchObject({ name: 'Researcher', appId: 'claude', instructions: researcher.role })
    expect(draft.allow.web).toBe(true)
  })

  it('chats with it at its thinking effort', () => {
    const draft = { name: 'Reader', does: '', instructions: 'Check.', appId: 'claude', model: 'opus', effort: 'max', skills: [], tools: [], doneWhen: [], allow: {}, figure: null }
    const team = parse(chatTeamYaml(draft, claude, 'opus', 'reader')) as { agents: Record<string, unknown>[] }
    expect(team.agents[0]).toMatchObject({ model: 'opus', thinkingEffort: 'max' })
  })

  it('chats with it as a team of one, with the model the app advertises', () => {
    const draft = { name: 'Release notes writer', does: '', instructions: 'Write the notes.', appId: 'claude', model: '', effort: '', skills: ['house-style'], tools: ['github'], doneWhen: [], allow: { web: true }, figure: null }
    const team = parse(chatTeamYaml(draft, claude, 'sonnet', 'release-notes-writer')) as Record<string, unknown>
    expect(team).toEqual({
      schemaVersion: 1,
      id: 'bench-release-notes-writer',
      name: 'Release notes writer · chat',
      entrypoint: 'release-notes-writer',
      agents: [{
        id: 'release-notes-writer', name: 'Release notes writer', role: 'Write the notes.',
        spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }, model: 'sonnet',
        // Its tools go with it, so its chat uses them as a team would.
        capabilities: [{ kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'github' }], allow: { web: true },
      }],
    })
  })

  it('keeps its chat’s agent under the chat’s id, whatever the agent is called', () => {
    const draft = { name: 'Release notes writer', does: '', instructions: 'Write the notes.', appId: 'claude', model: '', effort: '', skills: [], tools: [], doneWhen: [], allow: {}, figure: null }
    const before = parse(chatTeamYaml(draft, claude, 'sonnet', 'notes')) as { id: string; name: string; entrypoint: string; agents: { id: string; name: string }[] }
    const renamed = parse(chatTeamYaml({ ...draft, name: 'Changelog writer' }, claude, 'sonnet', 'notes')) as typeof before
    expect(before).toMatchObject({ id: 'bench-notes', name: 'Release notes writer · chat', entrypoint: 'notes', agents: [{ id: 'notes', name: 'Release notes writer' }] })
    // The same file, and the same agent in it: its history and a note for its turn still find it.
    expect(renamed).toMatchObject({ id: 'bench-notes', entrypoint: 'notes', agents: [{ id: 'notes', name: 'Changelog writer' }] })
    expect(chatAgentId('notes')).toBe('notes')
  })
})
