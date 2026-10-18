import { describe, expect, it } from 'vitest'

import type { AgentConfig } from '../team-file/types'
import { draftFromTeamAgent, knowledgeForChat, readsOf, teamAgentEdit, teamKnowledge, toolsOf } from './teamDraft'

const writer: AgentConfig = {
  id: 'writer', name: 'Writer', role: 'Write the digest.', model: 'sonnet', thinkingEffort: 'high',
  spawn: { cwd: 'work' },
  capabilities: [{ kind: 'folder', name: 'notes', path: 'notes' } as never, { kind: 'skill', name: 'house-style' }],
  allow: { web: true },
}

describe('a team’s own agent on the workbench', () => {
  it('reads the team agent as the workbench shows it', () => {
    expect(draftFromTeamAgent(writer)).toEqual({
      // A model written for an AI app reads as the OpenRouter model it maps to.
      name: 'Writer', does: '', instructions: 'Write the digest.', model: 'anthropic/claude-sonnet-5.5', effort: 'high', skills: ['house-style'], tools: [], toolAllow: {}, doneWhen: [], allow: { web: true }, figure: null,
    })
  })

  it('keeps a tool’s always-allowed calls with it, and changes only those (ADR 0069)', () => {
    const tooled = { ...writer, capabilities: [{ kind: 'skill' as const, name: 'house-style' }, { kind: 'tool' as const, name: 'Linear', alwaysAllow: ['create_issue'] }] }
    expect(draftFromTeamAgent(tooled).toolAllow).toEqual({ Linear: ['create_issue'] })
    // Giving it another tool keeps what Linear always may do.
    expect(teamAgentEdit(tooled, 'tools', ['Linear', 'DeepWiki'])).toEqual({ kind: 'fields', fields: { capabilities: [
      { kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'Linear', alwaysAllow: ['create_issue'] }, { kind: 'tool', name: 'DeepWiki' },
    ] } })
    // Allowing a call (named in any case) writes it on that tool; taking the last one back drops the list.
    expect(teamAgentEdit(tooled, 'toolAllow', { linear: ['create_issue', 'list_teams'] })).toEqual({ kind: 'fields', fields: { capabilities: [
      { kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'Linear', alwaysAllow: ['create_issue', 'list_teams'] },
    ] } })
    expect(teamAgentEdit(tooled, 'toolAllow', {})).toEqual({ kind: 'fields', fields: { capabilities: [
      { kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'Linear' },
    ] } })
  })

  it('writes done-when items to the team file, and none at all when every line is blank (ADR 0062)', () => {
    expect(draftFromTeamAgent({ ...writer, doneWhen: ['Five stories'] }).doneWhen).toEqual(['Five stories'])
    expect(teamAgentEdit(writer, 'doneWhen', [' Five stories ', ' '])).toEqual({ kind: 'fields', fields: { doneWhen: ['Five stories'] } })
    expect(teamAgentEdit(writer, 'doneWhen', ['  '])).toEqual({ kind: 'fields', fields: { doneWhen: undefined } })
  })

  it('writes names and instructions as renames, so typing stays one undo step at a time like the canvas', () => {
    expect(teamAgentEdit(writer, 'name', 'Editor')).toEqual({ kind: 'rename', field: 'name', value: 'Editor' })
    expect(teamAgentEdit(writer, 'instructions', 'Edit it.')).toEqual({ kind: 'rename', field: 'role', value: 'Edit it.' })
    expect(teamAgentEdit(writer, 'does', 'Palette line')).toBeNull()
  })

  it('writes a model chosen on the workbench to the team file', () => {
    expect(teamAgentEdit(writer, 'model', 'openai/gpt-6.1-sol')).toEqual({ kind: 'fields', fields: { model: 'openai/gpt-6.1-sol' } })
  })

  it('changes only its skills among its sources, and clears an effort back to the model’s default', () => {
    expect(teamAgentEdit(writer, 'skills', ['pdf'])).toEqual({ kind: 'fields', fields: { capabilities: [{ kind: 'folder', name: 'notes', path: 'notes' }, { kind: 'skill', name: 'pdf' }] } })
    expect(teamAgentEdit({ ...writer, capabilities: [{ kind: 'skill', name: 'house-style' }] }, 'skills', [])).toEqual({ kind: 'fields', fields: { capabilities: undefined } })
    expect(teamAgentEdit(writer, 'effort', '')).toEqual({ kind: 'fields', fields: { thinkingEffort: undefined } })
    expect(teamAgentEdit(writer, 'allow', { web: false, commands: true })).toEqual({ kind: 'fields', fields: { allow: { commands: true } } })
  })

  it('gives it tools from the workbench as capabilities the canvas draws, keeping its other sources', () => {
    const tooled: AgentConfig = { ...writer, capabilities: [...(writer.capabilities ?? []), { kind: 'tool', name: 'github' }] }
    expect(draftFromTeamAgent(tooled).tools).toEqual(['github'])
    expect(teamAgentEdit(tooled, 'tools', ['github', 'linear'])).toEqual({ kind: 'fields', fields: { capabilities: [
      { kind: 'folder', name: 'notes', path: 'notes' }, { kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'github' }, { kind: 'tool', name: 'linear' },
    ] } })
    expect(teamAgentEdit({ ...writer, capabilities: [{ kind: 'tool', name: 'github' }] }, 'tools', [])).toEqual({ kind: 'fields', fields: { capabilities: undefined } })
    // Giving it a tool turned off for it on the canvas turns it back on, as drawing its line would.
    const off: AgentConfig = { ...writer, turnedOff: [{ kind: 'tool', name: 'Linear' }, { kind: 'skill', name: 'pdf' }] }
    expect(teamAgentEdit(off, 'tools', ['linear'])).toMatchObject({ kind: 'fields', fields: { turnedOff: [{ kind: 'skill', name: 'pdf' }] } })
    expect(teamAgentEdit({ ...writer, turnedOff: [{ kind: 'tool', name: 'linear' }] }, 'tools', ['linear'])).toMatchObject({ kind: 'fields', fields: { turnedOff: undefined } })
    expect(teamAgentEdit(off, 'tools', ['github'])).not.toHaveProperty('fields.turnedOff')
  })

  it('reads what the team gives it to read, for its drawer: folders, files and Notion pages, in order', () => {
    expect(readsOf({ capabilities: [
      { kind: 'skill', name: 'house-style' },
      { kind: 'knowledge', name: 'notes', path: '/Users/me/notes' },
      { kind: 'tool', name: 'github' },
      { kind: 'knowledge', name: 'brief.md', path: 'digest.files/brief.md' },
      { kind: 'knowledge', name: 'ref.pdf', path: '/Users/me/ref.pdf' },
      { kind: 'knowledge', name: 'Hub', notion: { page: 'abc' } },
      // Knowledge without a path names nothing it can read (ADR 0036).
      { kind: 'knowledge', name: 'nowhere' },
      { kind: 'knowledge', name: '', path: '/Users/me/unnamed/' },
    ] })).toEqual([
      { kind: 'folder', name: 'notes', where: '/Users/me/notes' },
      { kind: 'file', name: 'brief.md', where: 'digest.files/brief.md' },
      { kind: 'file', name: 'ref.pdf', where: '/Users/me/ref.pdf' },
      { kind: 'page', name: 'Hub', where: 'Notion page · read when each run starts' },
      { kind: 'folder', name: 'unnamed', where: '/Users/me/unnamed/' },
    ])
    expect(readsOf({})).toEqual([])
  })

  it('gives its chat in the team what the team gives it to read, naming the same files from the chat’s folder', () => {
    const knowledge = teamKnowledge({ capabilities: [
      { kind: 'skill', name: 'house-style' },
      { kind: 'knowledge', name: 'notes', path: '/Users/me/notes' },
      { kind: 'tool', name: 'github' },
      { kind: 'knowledge', name: 'brief.md', path: 'digest.files/brief.md' },
      { kind: 'knowledge', name: 'Hub', notion: { page: 'abc' } },
      { kind: 'knowledge', name: 'home', path: '~/Documents/home' },
      { kind: 'knowledge', name: 'shared', path: './../shared' },
      // What the drawer doesn't list, the chat isn't given either (ADR 0036).
      { kind: 'knowledge', name: 'nowhere' },
    ] }, 'digest.yaml')
    expect(knowledge.capabilities.map((capability) => capability.name)).toEqual(['notes', 'brief.md', 'Hub', 'home', 'shared'])
    expect(knowledgeForChat(knowledge, '.jobs/.bench/team-digest-writer.yaml')).toEqual([
      { kind: 'knowledge', name: 'notes', path: '/Users/me/notes' },
      // A file added beside the team is read from the team file's folder, not the chat's.
      { kind: 'knowledge', name: 'brief.md', path: '../../digest.files/brief.md' },
      { kind: 'knowledge', name: 'Hub', notion: { page: 'abc' } },
      { kind: 'knowledge', name: 'home', path: '~/Documents/home' },
      { kind: 'knowledge', name: 'shared', path: '../../../shared' },
    ])
    // A team in a folder of its own, and one named by its full path.
    const nested = teamKnowledge({ capabilities: [{ kind: 'knowledge', name: 'brief.md', path: 'digest.files/brief.md' }] }, 'news/digest.yaml')
    expect(knowledgeForChat(nested, '.jobs/.bench/chat.yaml')[0].path).toBe('../../news/digest.files/brief.md')
    expect(knowledgeForChat({ ...nested, teamPath: '/Users/me/teams/news/digest.yaml' }, '.jobs/.bench/chat.yaml')[0].path).toBe('/Users/me/teams/news/digest.files/brief.md')
    expect(teamKnowledge({}, 'digest.yaml').capabilities).toEqual([])
  })

  it('takes the tools the team gives it, for its tool drawer: each MCP server once, in order', () => {
    expect(toolsOf({ capabilities: [
      { kind: 'tool', name: 'github' },
      { kind: 'skill', name: 'house-style' },
      { kind: 'knowledge', name: 'notes', path: '/Users/me/notes' },
      { kind: 'tool', name: ' notion ' },
      // The same server given twice is still one tool, and a nameless one names nothing.
      { kind: 'tool', name: 'github' },
      { kind: 'tool', name: '  ' },
    ] })).toEqual(['github', 'notion'])
    expect(toolsOf({})).toEqual([])
  })
})
