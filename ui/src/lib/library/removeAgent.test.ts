import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { TeamFileModel } from '../team-file/document'
import type { TeamDocument } from '../team-file/types'
import { removeFromMyAgents } from './removeAgent'

// A writer from My agents, checked by a reviewer, between a researcher and the reply.
const TEAM = `schemaVersion: 1
# Mine: kept as I wrote it.
id: blog
name: Blog
entrypoint: writer
responder: writer
agents:
  - id: writer
    name: Writer
    from: { agent: writer, version: 1 }
    model: fake/offline
    role: Write.
  - id: reviewer
    name: Reviewer
    model: fake/offline
    role: Check.
    checks: writer
    sendBack: true
  - id: researcher
    name: Researcher
    model: fake/offline
    role: Find.
edges:
  - { from: writer, to: reviewer }
  - { from: researcher, to: reviewer }
`

describe('Taking agent cards off a team (ADR 0100)', () => {
  it('changes the file as deleting the cards in Workflow does', () => {
    const team = TeamFileModel.parse(TEAM)
    const result = team.removeAgentCards(['writer'])
    const after = parse(team.toYaml()) as TeamDocument
    expect(after.agents.map((agent) => agent.id)).toEqual(['reviewer', 'researcher'])
    expect(after.edges).toEqual([{ from: 'researcher', to: 'reviewer' }])
    expect(after.agents[0]).not.toHaveProperty('checks')
    expect(after.agents[0]).not.toHaveProperty('sendBack')
    expect(result.unchecked).toEqual(['reviewer'])
    // Two agents are left, so neither takes the first place on its own, and no one replies for it.
    expect(after).not.toHaveProperty('entrypoint')
    expect(after).not.toHaveProperty('responder')
    expect(result.entrypoint).toBeNull()
    expect(team.toYaml()).toContain('# Mine: kept as I wrote it.')
  })

  it('passes the first place to the one agent left, which then replies', () => {
    const team = TeamFileModel.parse(TEAM)
    team.removeAgentCards(['writer', 'researcher'])
    const after = parse(team.toYaml()) as TeamDocument
    expect(after.entrypoint).toBe('reviewer')
    expect(after.responder).toBe('reviewer')
  })
})

// Researcher hands to the writer from My agents, whose work the reviewer checks.
const LINE = `schemaVersion: 1
id: blog
name: Blog
entrypoint: researcher
agents:
  - {id: researcher, name: Researcher, model: fake/offline, role: Find.}
  - {id: writer, name: Writer, from: {agent: writer, version: 1}, model: fake/offline, role: Write.}
  - {id: reviewer, name: Reviewer, model: fake/offline, role: Check., checks: writer}
edges:
  - {from: researcher, to: writer, layer: configured, kind: sequence, ts: "2026-10-29T00:00:00Z"}
  - {from: writer, to: reviewer, layer: configured, kind: sequence, ts: "2026-10-29T00:00:00Z"}
`

describe('Removing one of My agents in one step (ADR 0100)', () => {
  const calls: { method: string; url: string; body?: string }[] = []
  let yaml = LINE
  beforeEach(() => {
    yaml = LINE
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: String(init.body) } : {}) })
      if (url.startsWith('/api/team?') && init?.method === 'DELETE') return new Response(JSON.stringify({ trash: '.trash/blog' }), { status: 200 })
      if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', yaml, revision: 'r1' }), { status: 200 })
      if (url === '/api/team') return new Response(JSON.stringify({ path: 'blog.yaml', yaml: JSON.parse(String(init?.body)).yaml, revision: 'r2' }), { status: 200 })
      if (url === '/api/jobs/writer') return new Response(JSON.stringify({ id: 'writer' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('takes it off each team it is in, closing up the line, then removes it', async () => {
    await removeFromMyAgents('writer', [{ teamPath: 'blog.yaml', teamName: 'Blog', agentId: 'writer' }])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/team?path=blog.yaml', 'PUT /api/team', 'DELETE /api/jobs/writer'])
    const saved = parse(JSON.parse(calls[1].body ?? '{}').yaml) as TeamDocument
    expect(saved.agents.map((agent) => agent.id)).toEqual(['researcher', 'reviewer'])
    expect(saved.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['researcher>reviewer'])
    expect(saved.agents[1]).not.toHaveProperty('checks')
  })

  it('sends a team with no other agent to the trash, as Delete team does', async () => {
    yaml = 'schemaVersion: 1\nid: solo\nname: Solo\nentrypoint: writer\nagents:\n  - {id: writer, from: {agent: writer, version: 1}, model: fake/offline, role: Write.}\nedges: []\n'
    await removeFromMyAgents('writer', [{ teamPath: 'solo.yaml', teamName: 'Solo', agentId: 'writer' }])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/team?path=solo.yaml', 'DELETE /api/team?path=solo.yaml', 'DELETE /api/jobs/writer'])
  })

  // ADR 0103: a team in several projects is one team; a save at one place writes the others.
  it('saves a team in several projects once, and sends every place of an emptied one to the trash', async () => {
    await removeFromMyAgents('writer', [{ teamPath: 'blog.yaml', teamName: 'Blog', agentId: 'writer', places: ['blog-site.yaml'] }])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/team?path=blog.yaml', 'PUT /api/team', 'DELETE /api/jobs/writer'])
    calls.length = 0
    yaml = 'schemaVersion: 1\nid: solo\nshares: solo\nname: Solo\nentrypoint: writer\nagents:\n  - {id: writer, from: {agent: writer, version: 1}, model: fake/offline, role: Write.}\nedges: []\n'
    await removeFromMyAgents('writer', [{ teamPath: 'solo.yaml', teamName: 'Solo', agentId: 'writer', places: ['solo-site.yaml'] }])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/team?path=solo.yaml', 'DELETE /api/team?path=solo.yaml', 'DELETE /api/team?path=solo-site.yaml', 'DELETE /api/jobs/writer'])
  })

  it('reads every team before it saves any, so one that can’t tell who starts changes none', async () => {
    const choose = LINE.replace('entrypoint: researcher', 'entrypoint: writer').replace(/  - \{from: researcher.*\n/, '  - {from: writer, to: researcher, layer: configured, kind: sequence, ts: "2026-10-29T00:00:00Z"}\n')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', url })
      if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'x', yaml: url.includes('second') ? choose : LINE, revision: 'r1' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }))
    await expect(removeFromMyAgents('writer', [{ teamPath: 'first.yaml', teamName: 'First', agentId: 'writer' }, { teamPath: 'second.yaml', teamName: 'Second', agentId: 'writer' }])).rejects.toThrow('Second starts with this agent')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('changes nothing when a team can’t tell who starts without it', async () => {
    yaml = LINE.replace('entrypoint: researcher', 'entrypoint: writer').replace(/  - \{from: researcher.*\n/, '  - {from: writer, to: researcher, layer: configured, kind: sequence, ts: "2026-10-29T00:00:00Z"}\n')
    await expect(removeFromMyAgents('writer', [{ teamPath: 'blog.yaml', teamName: 'Blog', agentId: 'writer' }])).rejects.toThrow('Blog starts with this agent')
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('leaves My agents alone when a team can’t be changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input) })
      if (String(input).startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', yaml: LINE, revision: 'r1' }), { status: 200 })
      return new Response(JSON.stringify({ error: 'This team was changed in another window.' }), { status: 412 })
    }))
    await expect(removeFromMyAgents('writer', [{ teamPath: 'blog.yaml', teamName: 'Blog', agentId: 'writer' }])).rejects.toThrow('changed in another window')
    expect(calls.map((call) => call.method)).not.toContain('DELETE')
  })
})
