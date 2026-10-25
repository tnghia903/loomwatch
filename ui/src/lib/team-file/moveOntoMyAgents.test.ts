import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { movedLine, movedLines, moveOntoMyAgents, type MoveStatus } from './moveOntoMyAgents'
import type { TeamDocument } from './types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// The blog team has an agent of its own and a copy of Researcher from an older save of it.
const BLOG = `schemaVersion: 1
id: blog
name: Blog
entrypoint: writer
agents:
  # Writes the posts.
  - id: writer
    name: Writer
    role: Write the post.
    model: fake/offline
    spawn:
      cwd: posts
  - id: researcher
    name: Researcher
    role: Find facts.
    model: fake/offline
    from:
      agent: researcher
      version: 1
edges: []
`
// A team downloaded and never looked at: it waits for a review, so it isn't moved.
const DOWNLOADED = BLOG.replace('id: blog', 'id: downloaded').replace('name: Blog', 'name: Downloaded')

function daemon() {
  const agents = new Map<string, Record<string, unknown>>([['researcher', {
    id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts with sources.', model: 'fake/offline', version: 2,
  }]])
  const teams = new Map([['blog.yaml', BLOG], ['downloaded.yaml', DOWNLOADED]])
  const recorded: unknown[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return json({ folder: '.jobs', jobs: [...agents.values()], problems: [] })
    const agent = /^\/api\/jobs\/([^/]+)$/.exec(url)
    if (agent && init?.method === 'PUT') {
      const saved = { ...JSON.parse(String(init.body)) as Record<string, unknown>, id: agent[1], file: `.jobs/${agent[1]}.yaml`, version: 1 }
      agents.set(agent[1], saved)
      return json(saved)
    }
    if (url.startsWith('/api/team?')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
      return json({ path, yaml: teams.get(path), revision: `rev-${path}` })
    }
    if (url === '/api/team' && init?.method === 'PUT') {
      const { path, yaml } = JSON.parse(String(init.body)) as { path: string; yaml: string }
      teams.set(path, yaml)
      return json({ path, yaml })
    }
    if (url === '/api/my-agents/move' && init?.method === 'POST') {
      recorded.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }
    return json({ error: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return { agents, teams, recorded, fetch }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('every team moves onto My agents, once (ADR 0094)', () => {
  const status: MoveStatus = { moved: false, teams: [{ path: 'blog.yaml', approved: true }, { path: 'downloaded.yaml', approved: false }], changed: {} }

  it('makes each agent one of My agents, keeps only the team’s fields and comments, and says what runs differently', async () => {
    const { agents, teams, recorded } = daemon()
    const changed = await moveOntoMyAgents(status)

    // The team's own agent became one of My agents, as it was.
    expect(agents.get('writer')).toMatchObject({ name: 'Writer', instructions: 'Write the post.', model: 'fake/offline' })
    // The copy gave way to Researcher as it is in My agents, which runs differently, so it says so.
    expect(agents.get('researcher')).toMatchObject({ instructions: 'Find facts with sources.', version: 2 })
    const said = ['Researcher now works as you last saved it in My agents, not as this team’s older copy.']
    expect(changed).toEqual({ 'blog.yaml': said })
    expect(recorded).toEqual([{ changed: { 'blog.yaml': said } }])

    const blog = teams.get('blog.yaml')!
    expect(blog).toContain('# Writes the posts.')
    expect((parse(blog) as TeamDocument).agents).toEqual([
      { id: 'writer', spawn: { cwd: 'posts' }, from: { agent: 'writer' } },
      { id: 'researcher', from: { agent: 'researcher' } },
    ])
    // A team waiting for its review is left as it was written.
    expect(teams.get('downloaded.yaml')).toBe(DOWNLOADED)
  })

  it('says when a name had to change because another agent has it', async () => {
    const { agents } = daemon()
    agents.set('writer', { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write for investors.', version: 3 })
    const changed = await moveOntoMyAgents(status)
    expect(agents.get('writer-blog')).toMatchObject({ name: 'Writer · Blog', instructions: 'Write the post.' })
    expect(changed['blog.yaml']).toEqual(['Researcher now works as you last saved it in My agents, not as this team’s older copy.', 'Writer is now called Writer · Blog, since My agents already has a different Writer.'])
  })

  it('says which agents changed in a team, and the model one now thinks with', () => {
    expect(movedLine(movedLines([{ name: 'Researcher' }], []))).toBe('Researcher now works as you last saved it in My agents, not as this team’s older copy.')
    expect(movedLine(movedLines([{ name: 'Researcher', model: 'anthropic/claude-opus-5.5' }, { name: 'Writer' }], [{ from: 'Editor', to: 'Editor · Blog' }])))
      .toBe('Researcher and Writer now work as you last saved them in My agents, not as this team’s older copies. Researcher now thinks with Claude Opus 5.5. Editor is now called Editor · Blog, since My agents already has a different Editor.')
  })
})
