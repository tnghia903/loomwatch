import { describe, expect, it } from 'vitest'

import type { AgentConfig } from '../team-file/types'
import type { SavedJob } from './jobs'
import { changedHere, fieldsForVersion, linkState } from './link'

const job: SavedJob = { id: 'reader', file: '.jobs/reader.yaml', name: 'Reader', instructions: 'Check every story.', model: 'anthropic/claude-sonnet-5.5', skills: ['source-check'], allow: { web: true }, version: 3 }

const placed: AgentConfig = {
  id: 'reader', name: 'Reader', role: 'Check every story.', model: 'anthropic/claude-sonnet-5.5',
  spawn: { cwd: 'work' },
  capabilities: [{ kind: 'skill', name: 'source-check' }, { kind: 'knowledge', name: 'sources.md', path: 'sources.md' }],
  allow: { web: true },
  from: { agent: 'reader', version: 2 },
}

describe('the versioned link to My agents', () => {
  it('says which version a team copies and whether a newer one is ready', () => {
    expect(linkState({ ...placed, from: undefined }, [job])).toBeNull()
    expect(linkState(placed, [job])).toEqual({ job, version: 2, latest: 3, behind: true })
    expect(linkState({ ...placed, from: { agent: 'reader', version: 3 } }, [job])).toMatchObject({ behind: false })
    expect(linkState(placed, [])).toEqual({ job: null, version: 2, latest: null, behind: false })
  })

  it('updates what the version decides and keeps what is the team’s own', () => {
    const next = { ...job, instructions: 'Check every story twice.', skills: ['source-check', 'house-style'], tools: ['github'], allow: { web: true, edits: true } }
    // A tool the team drew to it is replaced by the version's, like a skill: the version decides them.
    const withTool: AgentConfig = { ...placed, capabilities: [...(placed.capabilities ?? []), { kind: 'tool', name: 'linear' }] }
    const fields = fieldsForVersion(next, withTool)
    expect(fields).toEqual({
      name: 'Reader',
      role: 'Check every story twice.',
      capabilities: [{ kind: 'knowledge', name: 'sources.md', path: 'sources.md' }, { kind: 'skill', name: 'source-check' }, { kind: 'skill', name: 'house-style' }, { kind: 'tool', name: 'github' }],
      allow: { web: true, edits: true },
      allowRecruiting: true,
      from: { agent: 'reader', version: 3 },
      model: 'anthropic/claude-sonnet-5.5',
    })
    // Where it works is the team's own.
    expect(fields).not.toHaveProperty('spawn')
    // Whether it brings in helpers is the version's (ADR 0079).
    expect(fieldsForVersion({ ...next, helpers: false }, withTool)).toMatchObject({ allowRecruiting: false })
    expect(changedHere({ ...placed, allowRecruiting: false }, { ...job, version: 2 })).toEqual(['helpers'])
  })

  it('moves the agent to the version’s model, and its thinking effort with it', () => {
    const harder = { ...job, model: 'openai/gpt-6.1-sol', thinkingEffort: 'high', version: 4 }
    expect(fieldsForVersion(harder, placed)).toMatchObject({ model: 'openai/gpt-6.1-sol', thinkingEffort: 'high' })
    // A version saved without a model leaves the agent on its own.
    expect(fieldsForVersion({ ...job, model: undefined }, placed)).not.toHaveProperty('model')
  })

  it('names what the team changed since its version, ignoring the order of skills', () => {
    const pinned = { ...job, version: 2 }
    expect(changedHere(placed, pinned)).toEqual([])
    const reordered: AgentConfig = { ...placed, capabilities: [{ kind: 'knowledge', name: 'x', path: 'x' }, { kind: 'skill', name: 'source-check' }] }
    expect(changedHere(reordered, pinned)).toEqual([])
    const edited: AgentConfig = { ...placed, role: 'Something else.', capabilities: [], allow: undefined }
    expect(changedHere(edited, pinned)).toEqual(['instructions', 'skills', 'what it may do without asking'])
    // A tool drawn to it on the canvas is a change too, until it is put back or updated.
    const tooled: AgentConfig = { ...placed, capabilities: [...(placed.capabilities ?? []), { kind: 'tool', name: 'github' }] }
    expect(changedHere(tooled, pinned)).toEqual(['tools'])
    expect(changedHere(tooled, { ...pinned, tools: ['github'] })).toEqual([])
  })

  it('brings what the version reads into the team, beside what the team gives it', () => {
    const reading = { ...job, reads: [{ name: 'Brand', path: '/Users/me/brand' }, { name: 'sources.md', notion: { page: 'abc' } }] }
    const fields = fieldsForVersion(reading, placed)
    expect(fields.capabilities).toEqual([
      // The team's own stays, and a version's read with a label the team uses takes another.
      { kind: 'knowledge', name: 'sources.md', path: 'sources.md' },
      { kind: 'knowledge', name: 'Brand', path: '/Users/me/brand' },
      { kind: 'knowledge', name: 'sources.md (2)', notion: { page: 'abc' } },
      { kind: 'skill', name: 'source-check' },
    ])
    // Already in the team, it is the version's entry, once.
    const updated: AgentConfig = { ...placed, capabilities: fields.capabilities }
    expect(fieldsForVersion(reading, updated).capabilities?.filter((capability) => capability.kind === 'knowledge')).toHaveLength(3)
  })

  it('takes away what only the version it leaves read, and nothing the team gave it', () => {
    const was = { reads: [{ name: 'Brand', path: '/Users/me/brand' }, { name: 'Old notes', path: '/Users/me/old' }] }
    const inTeam: AgentConfig = { ...placed, capabilities: [...(placed.capabilities ?? []), { kind: 'knowledge', name: 'Brand', path: '/Users/me/brand' }, { kind: 'knowledge', name: 'Old notes', path: '/Users/me/old' }] }
    const next = { ...job, reads: [{ name: 'Brand', path: '/Users/me/brand' }] }
    expect(fieldsForVersion(next, inTeam, was).capabilities?.filter((capability) => capability.kind === 'knowledge')).toEqual([
      { kind: 'knowledge', name: 'sources.md', path: 'sources.md' },
      { kind: 'knowledge', name: 'Brand', path: '/Users/me/brand' },
    ])
    // Without the version it leaves, nothing it had is taken away.
    expect(fieldsForVersion(next, inTeam).capabilities?.filter((capability) => capability.kind === 'knowledge')).toHaveLength(3)
  })

  it('names a read of its version the team took away, but not one the team added', () => {
    const pinned = { ...job, version: 2, reads: [{ name: 'sources.md', path: 'sources.md' }] }
    expect(changedHere(placed, pinned)).toEqual([])
    expect(changedHere({ ...placed, capabilities: [{ kind: 'skill', name: 'source-check' }] }, pinned)).toEqual(['what it reads'])
  })
})
