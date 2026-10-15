import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from '../harnesses'
import type { AgentConfig } from '../team-file/types'
import { draftFromTeamAgent, teamAgentEdit } from './teamDraft'

const claude: DetectedHarness = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', executablePath: '/bin/claude-agent-acp', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }
const codex: DetectedHarness = { id: 'codex', name: 'Codex', command: 'codex-acp', executablePath: '/bin/codex-acp', acpAvailable: true, spawn: { cmd: 'codex-acp', args: ['--quiet'] } }
const writer: AgentConfig = {
  id: 'writer', name: 'Writer', role: 'Write the digest.', model: 'sonnet', thinkingEffort: 'high',
  spawn: { cmd: 'claude-agent-acp', args: [], env: { KEEP: '1' }, cwd: 'work' },
  capabilities: [{ kind: 'folder', name: 'notes', path: 'notes' } as never, { kind: 'skill', name: 'house-style' }],
  allow: { web: true },
}

describe('a team’s own agent on the workbench', () => {
  it('reads the team agent as the workbench shows it', () => {
    expect(draftFromTeamAgent(writer, [claude, codex])).toEqual({
      name: 'Writer', does: '', instructions: 'Write the digest.', appId: 'claude', model: 'sonnet', effort: 'high', skills: ['house-style'], doneWhen: [], allow: { web: true }, figure: null,
    })
  })

  it('writes done-when items to the team file, and none at all when every line is blank (ADR 0062)', () => {
    expect(draftFromTeamAgent({ ...writer, doneWhen: ['Five stories'] }, [claude]).doneWhen).toEqual(['Five stories'])
    expect(teamAgentEdit(writer, 'doneWhen', [' Five stories ', ' '], [claude])).toEqual({ kind: 'fields', fields: { doneWhen: ['Five stories'] } })
    expect(teamAgentEdit(writer, 'doneWhen', ['  '], [claude])).toEqual({ kind: 'fields', fields: { doneWhen: undefined } })
  })

  it('writes names and instructions as renames, so typing stays one undo step at a time like the canvas', () => {
    expect(teamAgentEdit(writer, 'name', 'Editor', [claude])).toEqual({ kind: 'rename', field: 'name', value: 'Editor' })
    expect(teamAgentEdit(writer, 'instructions', 'Edit it.', [claude])).toEqual({ kind: 'rename', field: 'role', value: 'Edit it.' })
    expect(teamAgentEdit(writer, 'does', 'Palette line', [claude])).toBeNull()
  })

  it('moves it to another app with that app’s command, keeping its folder and settings, and resets model and effort', () => {
    expect(teamAgentEdit(writer, 'appId', 'codex', [claude, codex])).toEqual({ kind: 'fields', fields: {
      spawn: { cmd: 'codex-acp', args: ['--quiet'], env: { KEEP: '1' }, cwd: 'work' }, model: '', thinkingEffort: undefined,
    } })
    expect(teamAgentEdit(writer, 'appId', 'missing', [claude])).toBeNull()
  })

  it('changes only its skills among its sources, and clears an effort back to the app default', () => {
    expect(teamAgentEdit(writer, 'skills', ['pdf'], [claude])).toEqual({ kind: 'fields', fields: { capabilities: [{ kind: 'folder', name: 'notes', path: 'notes' }, { kind: 'skill', name: 'pdf' }] } })
    expect(teamAgentEdit({ ...writer, capabilities: [{ kind: 'skill', name: 'house-style' }] }, 'skills', [], [claude])).toEqual({ kind: 'fields', fields: { capabilities: undefined } })
    expect(teamAgentEdit(writer, 'effort', '', [claude])).toEqual({ kind: 'fields', fields: { thinkingEffort: undefined } })
    expect(teamAgentEdit(writer, 'allow', { web: false, commands: true }, [claude])).toEqual({ kind: 'fields', fields: { allow: { commands: true } } })
  })
})
