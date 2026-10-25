import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CapabilityInventory } from '../../lib/library/client'
import { ComponentPalette } from './ComponentPalette'
import { CAPABILITY_DRAG_MIME, CONNECTION_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'

let jobs: object[] = []
let problems: object[] = []
const removed: string[] = []
/** Team files by path, with the team's name, for the agents that live in teams. */
let teams: Record<string, { name: string; yaml: string }> = {}

beforeEach(() => {
  jobs = []
  problems = []
  teams = {}
  removed.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs, problems }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: Object.keys(teams), teams: Object.entries(teams).map(([path, team]) => ({ path, name: team.name, agentCount: 2 })) }), { status: 200 })
    if (url.startsWith('/api/team?')) {
      const path = new URLSearchParams(url.slice('/api/team?'.length)).get('path') ?? ''
      const team = teams[path]
      return team ? new Response(JSON.stringify({ path, yaml: team.yaml, revision: 'r1' }), { status: 200 }) : new Response(JSON.stringify({ error: 'no such team' }), { status: 404 })
    }
    if (url.startsWith('/api/jobs/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(url.slice('/api/jobs/'.length))
      removed.push(id)
      jobs = jobs.filter((job) => (job as { id: string }).id !== id)
      return new Response(JSON.stringify({ id, movedTo: `.jobs/.removed/x-${id}.yaml` }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true }) })

const palette = () => render(<ComponentPalette />)
const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement

describe('ComponentPalette jobs', () => {
  // The built-in jobs are templates in Your agents now: a team's agents are built and tried there first.
  it('hires no built-in jobs, and before any agent is saved says where to build one', async () => {
    render(<ComponentPalette teamPath="desk/research.yaml" />)
    expect(screen.queryByRole('heading', { name: 'Hire by job' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Researcher/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Blank agent/ })).toBeNull()
    const yours = section('My agents')
    expect(await within(yours).findByText('None yet')).toBeInTheDocument()
    expect(within(yours).getByRole('link', { name: 'Build a new agent' })).toHaveAttribute('href', '/agents/new?team=desk%2Fresearch.yaml')
    fireEvent.click(within(yours).getByRole('button', { name: 'About My agents' }))
    // Agents are built in My agents before a team uses them, so it no longer offers to keep a team's own.
    expect(await screen.findByText(/Build one in/)).toBeInTheDocument()
    expect(screen.queryByText(/Add to My agents/)).toBeNull()
    // The review step is a step of the workflow, not an agent, so it stays here.
    expect(within(section('Workflow steps')).getByRole('button', { name: /^You \(review step\)/ })).toBeInTheDocument()
  })

  it('lists saved jobs first and places one with its skills, as the built-in jobs are placed', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', does: 'Drafts release notes', instructions: 'Write the notes.', model: 'openai/gpt-6.1-sol', skills: ['release-style'], file: '.jobs/release-notes.yaml' }]
    const added = vi.fn()
    window.addEventListener('loomwatch:add-agent', added)
    palette()
    const yours = await waitFor(() => section('My agents'))
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings.indexOf('My agents')).toBeLessThan(headings.indexOf('Workflow steps'))
    fireEvent.click(within(yours).getByRole('button', { name: /^Release notes/ }))
    const payload = JSON.parse((added.mock.calls[0][0] as CustomEvent<string>).detail)
    expect(payload).toMatchObject({ label: 'Release notes', role: 'Write the notes.', model: 'openai/gpt-6.1-sol', capabilities: [{ kind: 'skill', name: 'release-style' }], from: { agent: 'release-notes', version: 1 } })
    expect(payload).not.toHaveProperty('spawn')
    window.removeEventListener('loomwatch:add-agent', added)
  })

  it('removes a saved job only on a second click', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', instructions: 'Write the notes.', file: '.jobs/release-notes.yaml' }]
    palette()
    const remove = await screen.findByRole('button', { name: 'Remove Release notes from My agents' })
    fireEvent.click(remove)
    expect(removed).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Release notes from My agents' }))
    await waitFor(() => expect(removed).toEqual(['release-notes']))
    expect(await within(section('My agents')).findByText('None yet')).toBeInTheDocument()
  })

  // Home lists the agents written straight into a team with My agents; the canvas must list the same ones.
  it('lists the agents that live in teams: this team’s find their card, and another team’s come as a copy', async () => {
    teams = {
      'research/rag.yaml': { name: 'Enterprise RAG research', yaml: 'schemaVersion: 1\nid: rag\nname: Enterprise RAG research\nentrypoint: rag-researcher\nagents:\n  - id: rag-researcher\n    name: RAG researcher\n    role: Research RAG.\n' },
      'demo/review.yaml': { name: 'Review stop demo', yaml: [
        'schemaVersion: 1', 'id: review', 'name: Review stop demo', 'entrypoint: researcher', 'agents:',
        '  - id: researcher', '    name: Researcher', '    role: Find sources.', '    model: openai/gpt-6.1-sol', '    thinkingEffort: high',
        '    spawn: { cwd: /work/demo }', '    doneWhen: [Every claim has a link]', '    allow: { web: true }',
        '    capabilities:', '      - { kind: skill, name: web-research }', '      - { kind: knowledge, name: notes, path: demo.files/notes.md }',
        '  - id: you', '    kind: operator', '    name: You', '    role: Review.',
      ].join('\n') },
    }
    const reveal = vi.fn()
    const added = vi.fn()
    window.addEventListener('loomwatch:add-agent', added)
    render(<ComponentPalette teamPath="/teams/research/rag.yaml" teamAgents={[{ id: 'rag-researcher', name: 'RAG researcher' }]} onRevealAgent={reveal} />)
    const yours = section('My agents')
    const other = await within(yours).findByRole('button', { name: /^Researcher/ })
    expect(other).toHaveTextContent('in Review stop demo')
    // This team's agent is listed once, from the canvas, and a click finds its card instead of adding another.
    const here = within(yours).getAllByRole('button', { name: /^RAG researcher/ })
    expect(here).toHaveLength(1)
    expect(here[0]).toHaveTextContent('On this canvas')
    fireEvent.click(here[0])
    expect(reveal).toHaveBeenCalledWith('rag-researcher')
    expect(added).not.toHaveBeenCalled()
    // The review step is not an agent.
    expect(within(yours).queryByRole('button', { name: /^You/ })).toBeNull()
    expect(within(yours).queryByText('None yet')).toBeNull()
    fireEvent.click(other)
    const payload = JSON.parse((added.mock.calls[0][0] as CustomEvent<string>).detail)
    expect(payload).toMatchObject({ label: 'Researcher', role: 'Find sources.', model: 'openai/gpt-6.1-sol', thinkingEffort: 'high', doneWhen: ['Every claim has a link'], allow: { web: true } })
    // A copy this team owns: no link back, and nothing that names where the other team keeps its files.
    expect(payload.capabilities).toEqual([{ kind: 'skill', name: 'web-research' }])
    expect(payload).not.toHaveProperty('from')
    expect(payload).not.toHaveProperty('spawn')
    window.removeEventListener('loomwatch:add-agent', added)
  })

  it('says which job file it could not read instead of hiding it', async () => {
    problems = [{ file: '.jobs/broken.yaml', message: 'A job needs instructions: what should the agent do?' }]
    palette()
    expect(await screen.findByText(/Can’t read \.jobs\/broken\.yaml/)).toBeInTheDocument()
  })
})

const capabilities: CapabilityInventory = {
  skills: [{ id: 'skill-notebooklm', name: 'notebooklm', source: 'LoomWatch', detail: 'Research notebooks', status: 'Ready' }],
  // Team memory is the only knowledge the daemon lists (ADR 0036).
  sources: [{ id: 'memory-research', name: 'Research team · memory', source: 'LoomWatch', detail: '1 brief entry', status: 'Ready', memory: { team: 'research-team', brief: 1 } }],
}

/** ADR 0041: one add panel, beside the Workflow canvas. */
describe('ComponentPalette in Build', () => {
  it('lists LoomWatch’s skills and other teams’ memory, with no tools from AI apps, and a way to manage skills', () => {
    render(<ComponentPalette capabilityInventory={capabilities} capabilitiesScannedAt={new Date()} />)
    expect(within(section('Skills')).getByRole('button', { name: /notebooklm.*LoomWatch.*Ready/ })).toBeInTheDocument()
    expect(within(section('Skills')).getByRole('link', { name: 'Manage skills' })).toHaveAttribute('href', '/skills')
    expect(within(section('Team memory')).getByRole('button', { name: /Research team · memory/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tools' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'AI apps' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/Skills listed at/)
  })

  it('makes every row a real drag source with the payload the canvas reads', () => {
    const dragState = vi.fn()
    render(<ComponentPalette capabilityInventory={capabilities} onDragStateChange={dragState} />)
    for (const [name, mime, payload] of [
      [/^You \(review step\)/, LIBRARY_DRAG_MIME, '"kind":"operator"'],
      [/^notebooklm/, CAPABILITY_DRAG_MIME, '"kind":"skill"'],
      [/^Research team · memory/, CAPABILITY_DRAG_MIME, '"memory":{"team":"research-team"}'],
    ] as const) {
      const setData = vi.fn()
      fireEvent.dragStart(screen.getByRole('button', { name }), { dataTransfer: { setData, effectAllowed: '' } })
      expect(setData).toHaveBeenCalledWith(mime, expect.stringContaining(payload))
    }
    expect(dragState).toHaveBeenCalledWith(true)
  })

  it('adds a skill with its row and opens its details with the info button, without adding it', () => {
    const inspect = vi.fn()
    const placed = vi.fn()
    window.addEventListener('loomwatch:add-capability', placed)
    render(<ComponentPalette capabilityInventory={capabilities} onInspectCapability={inspect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details for notebooklm' }))
    expect(inspect).toHaveBeenCalledWith(capabilities.skills[0], 'skill')
    expect(placed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^notebooklm/ }))
    expect(JSON.parse((placed.mock.calls[0][0] as CustomEvent<string>).detail)).toMatchObject({ kind: 'skill', name: 'notebooklm' })
    window.removeEventListener('loomwatch:add-capability', placed)
  })

  it('says where web search, commands and file edits are switched on, since no skill is needed for them', () => {
    render(<ComponentPalette capabilityInventory={capabilities} />)
    fireEvent.click(within(section('Skills')).getByRole('button', { name: 'About Skills' }))
    expect(section('Skills')).toHaveTextContent('Web search, commands and file edits need no skill: switch them on per agent, under Allowed without asking.')
  })

  // An empty group is one dashed slot, not a paragraph; why it is empty is behind its "?".
  it('shows an empty group as a single slot', () => {
    render(<ComponentPalette capabilityInventory={{ skills: [], sources: [] }} />)
    expect(section('Skills').querySelector('.palette-empty')).toHaveTextContent('None yet')
    expect(section('Team memory').querySelector('.palette-empty')).toHaveTextContent('None yet')
  })

  /** ADR 0043: a folder or file is added from an agent's panel, so the add panel says where, and has no Add button of its own. */
  it('points Folders & files at the agent panel, with no Add folder of its own', () => {
    render(<ComponentPalette capabilityInventory={{ ...capabilities, sources: [] }} />)
    expect(section('Folders & files').querySelector('.palette-empty')).toHaveTextContent('None yet')
    fireEvent.click(within(section('Folders & files')).getByRole('button', { name: 'About Folders & files' }))
    expect(section('Folders & files')).toHaveTextContent('Add one from an agent’s panel, with Folder or File under Given.')
    expect(within(section('Folders & files')).queryByRole('button', { name: 'Add folder…' })).not.toBeInTheDocument()
    expect(within(section('Folders & files')).queryByRole('button', { name: 'Add file…' })).not.toBeInTheDocument()
    fireEvent.click(within(section('Team memory')).getByRole('button', { name: 'About Team memory' }))
    expect(section('Team memory')).toHaveTextContent('Other teams’ memory and imported packs.')
  })

  /**
   * ADR 0042: once added, a folder or file is a row of its own, like a skill: it says who reads
   * it, drags with its path so dropping it on an agent connects it there, finds its card on a
   * click, and opens its details with the info button.
   */
  it('lists this team\u2019s folders and files as rows that drag, find their card and open their details', () => {
    const reveal = vi.fn()
    const inspect = vi.fn()
    const item = { id: 'knowledge@/Users/me/reports', name: 'reports', source: 'Linked folder', path: '/Users/me/reports', detail: 'A folder on this computer.', status: 'Local only' as const }
    render(<ComponentPalette capabilityInventory={capabilities} onInspectCapability={inspect} onRevealSource={reveal} teamSources={[
      { id: item.id, name: 'reports', path: '/Users/me/reports', source: 'Linked folder', readers: ['Researcher', 'Analyst'], item },
      { id: 'knowledge@desk.files/brief.md', name: 'brief.md', path: 'desk.files/brief.md', source: 'Added file', readers: [], item: { ...item, id: 'knowledge@desk.files/brief.md', name: 'brief.md', path: 'desk.files/brief.md' } },
    ]} />)
    const files = section('Folders & files')
    const reports = within(files).getByRole('button', { name: /^reports.*Read by Researcher and Analyst.*Linked folder/ })
    expect(within(files).getByRole('button', { name: /^brief\.md.*No agent reads it yet.*Added file/ })).toBeInTheDocument()
    expect(files.querySelector('.palette-empty')).toBeNull()

    const setData = vi.fn()
    fireEvent.dragStart(reports, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(CAPABILITY_DRAG_MIME, JSON.stringify({ kind: 'knowledge', name: 'reports', source: 'Linked folder', path: '/Users/me/reports' }))

    const placed = vi.fn()
    window.addEventListener('loomwatch:add-capability', placed)
    fireEvent.click(reports)
    expect(reveal).toHaveBeenCalledWith('knowledge@/Users/me/reports')
    expect(placed).not.toHaveBeenCalled()
    window.removeEventListener('loomwatch:add-capability', placed)
    fireEvent.click(within(files).getByRole('button', { name: 'Details for reports' }))
    expect(inspect).toHaveBeenCalledWith(item, 'knowledge')
  })

  /**
   * ADR 0050: Connections holds Notion, which drags onto an agent to choose a page there, and
   * the pages this team reads under it, which drag and find their card like a file does.
   */
  it('lists Notion under Connections, with the pages this team reads under it', () => {
    const reveal = vi.fn()
    const choose = vi.fn()
    const page = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
    const item = { id: `notion@${page.replace(/-/g, '')}`, name: 'Roadmap', source: 'Notion page', notion: { page }, detail: 'A page in your Notion.', status: 'Ready' as const }
    render(<ComponentPalette capabilityInventory={capabilities} onRevealSource={reveal}
      notion={{ connection: { state: 'connected', name: 'Notion', destination: null, problem: null }, pages: [{ id: item.id, name: 'Roadmap', page, readers: ['Researcher'], item }], onChoosePage: choose }} />)
    const connections = section('Connections')
    const notion = within(connections).getByRole('button', { name: /^Notion.*Drag onto an agent, then choose a page.*Notion/ })
    const setData = vi.fn()
    fireEvent.dragStart(notion, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(CONNECTION_DRAG_MIME, JSON.stringify({ service: 'notion' }))
    fireEvent.click(notion)
    expect(choose).toHaveBeenCalledOnce()

    const roadmap = within(connections).getByRole('button', { name: /^Roadmap.*Read by Researcher/ })
    expect(roadmap).toHaveClass('nested')
    fireEvent.dragStart(roadmap, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(CAPABILITY_DRAG_MIME, JSON.stringify({ kind: 'knowledge', name: 'Roadmap', source: 'Notion page', notion: { page } }))
    fireEvent.click(roadmap)
    expect(reveal).toHaveBeenCalledWith(item.id)
    // A Notion page is not a folder or file, so it is listed once, here.
    expect(section('Folders & files')).not.toHaveTextContent('Roadmap')
  })

  it('offers to connect Notion when it is not, without letting it be dragged', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ComponentPalette notion={{ connection: { state: 'disconnected' }, pages: [] }} />)
    const notion = within(section('Connections')).getByRole('button', { name: /^Notion.*Not connected/ })
    expect(notion).toHaveAttribute('draggable', 'false')
    fireEvent.click(notion)
    expect(open).toHaveBeenCalledWith('/connections?tool=notion', '_blank', 'noopener')
  })

  /** The panel's right edge resizes it: dragged, with the arrow keys, and back to default on a double click. */
  it('resizes from its right edge, within its limits', () => {
    const onResize = vi.fn()
    render(<ComponentPalette width={240} onResize={onResize} />)
    const edge = screen.getByRole('separator', { name: 'Resize the panel' })
    expect(edge).toHaveAttribute('aria-valuenow', '240')
    fireEvent.keyDown(edge, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenLastCalledWith(256)
    fireEvent.keyDown(edge, { key: 'Home' })
    expect(onResize).toHaveBeenLastCalledWith(200)
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 240 })
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 333 })
    expect(onResize).toHaveBeenLastCalledWith(333)
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 2000 })
    expect(onResize).toHaveBeenLastCalledWith(520)
    fireEvent.pointerUp(edge, { pointerId: 1 })
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 300 })
    expect(onResize).toHaveBeenLastCalledWith(520)
    fireEvent.doubleClick(edge)
    expect(onResize).toHaveBeenLastCalledWith(210)
  })

  it('cannot be resized where nothing handles it', () => {
    render(<ComponentPalette />)
    expect(screen.queryByRole('separator', { name: 'Resize the panel' })).not.toBeInTheDocument()
  })

  it('shows a listing failure verbatim and lists again on request', () => {
    const scan = vi.fn()
    render(<ComponentPalette capabilitiesError="EACCES skills/notes" onRetryCapabilities={scan} />)
    expect(screen.getByRole('alert')).toHaveTextContent('EACCES skills/notes')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    fireEvent.click(screen.getByRole('button', { name: 'List the skills again' }))
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('shows skeleton rows, never a spinner, while it lists the skills', () => {
    render(<ComponentPalette capabilitiesLoading capabilityInventory={{ skills: [], sources: [] }} />)
    expect(section('Skills').querySelectorAll('.skel-row')).toHaveLength(2)
    expect(section('Skills')).not.toHaveTextContent('None yet')
  })

  it('folds on the shared events and ⌘\\ toggles it', () => {
    render(<ComponentPalette />)
    act(() => { window.dispatchEvent(new Event('loomwatch:close-library')) })
    expect(screen.queryByRole('complementary', { name: 'Add to your team' })).toBeNull()
    act(() => { window.dispatchEvent(new Event('loomwatch:toggle-library')) })
    expect(screen.getByRole('complementary', { name: 'Add to your team' })).toBeInTheDocument()
  })
})

