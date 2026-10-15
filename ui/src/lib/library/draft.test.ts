import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from '../harnesses'
import { benchTeamYaml, draftChanged, draftFromJob, draftFromPreset, makesNewVersion, specFromDraft } from './draft'
import { ROLE_PRESETS } from './roles'

const claude: DetectedHarness = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', executablePath: '/bin/claude-agent-acp', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }

describe('the agent builder’s draft', () => {
  it('saves what it shows and reads back the same', () => {
    const draft = { name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', appId: 'claude', model: 'sonnet', skills: ['source-check'], allow: { web: true, edits: false } }
    const spec = specFromDraft(draft, 'First cut')
    expect(spec).toEqual({ name: 'Reader', does: 'Checks stories', instructions: 'Check every story.', icon: 'review', apps: ['claude'], model: 'sonnet', skills: ['source-check'], allow: { web: true }, note: 'First cut' })
    expect(draftFromJob(spec)).toEqual({ ...draft, allow: { web: true } })
  })

  it('makes a new version only for what a team copies', () => {
    const saved = draftFromJob({ name: 'Reader', instructions: 'Check.', apps: ['claude'] })
    expect(makesNewVersion({ ...saved, does: 'Checks stories' }, saved)).toBe(false)
    expect(draftChanged({ ...saved, does: 'Checks stories' }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, allow: { commands: true } }, saved)).toBe(true)
    expect(makesNewVersion({ ...saved, skills: ['a'] }, saved)).toBe(true)
  })

  it('starts a new agent from a built-in job on the app that job prefers', () => {
    const researcher = ROLE_PRESETS.find((preset) => preset.id === 'researcher')!
    const draft = draftFromPreset(researcher, [claude])
    expect(draft).toMatchObject({ name: 'Researcher', appId: 'claude', instructions: researcher.role })
    expect(draft.allow.web).toBe(true)
  })

  it('tries it as a team of one, with the model the app advertises', () => {
    const draft = { name: 'Release notes writer', does: '', instructions: 'Write the notes.', appId: 'claude', model: '', skills: ['house-style'], allow: { web: true } }
    const team = parse(benchTeamYaml(draft, claude, 'sonnet', 'release-notes-writer')) as Record<string, unknown>
    expect(team).toEqual({
      schemaVersion: 1,
      id: 'bench-release-notes-writer',
      name: 'Release notes writer · test bench',
      entrypoint: 'release-notes-writer',
      agents: [{
        id: 'release-notes-writer', name: 'Release notes writer', role: 'Write the notes.',
        spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }, model: 'sonnet',
        capabilities: [{ kind: 'skill', name: 'house-style' }], allow: { web: true },
      }],
    })
  })
})
