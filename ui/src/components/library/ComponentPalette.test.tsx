import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import type { CapabilityInventory } from '../../lib/library/client'
import { projectRun, type RunEvent } from '../../lib/watch/events'
import { ComponentPalette } from './ComponentPalette'
import { CAPABILITY_DRAG_MIME, CONNECTION_DRAG_MIME, EVIDENCE_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'

const codex: DetectedHarness = { id: 'codex', name: 'Codex', command: 'codex', executablePath: '/bin/codex', spawn: { cmd: 'codex', args: ['acp'] }, acpAvailable: true }

let jobs: object[] = []
let problems: object[] = []
const removed: string[] = []

beforeEach(() => {
  jobs = []
  problems = []
  removed.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs, problems }), { status: 200 })
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

const palette = () => render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} />)
const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement

describe('ComponentPalette jobs', () => {
  it('shows the built-in jobs and, before any is saved, how to save one', async () => {
    palette()
    expect(within(section('Hire by job')).getByText('Researcher')).toBeInTheDocument()
    fireEvent.click(within(section('Hire by job')).getByRole('button', { name: 'About Hire by job' }))
    expect(await screen.findByText(/select it and choose/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your jobs' })).toBeNull()
  })

  it('lists saved jobs first and places one with its skills, as the built-in jobs are placed', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', does: 'Drafts release notes', instructions: 'Write the notes.', apps: ['codex'], skills: ['release-style'], file: '.jobs/release-notes.yaml' }]
    const added = vi.fn()
    window.addEventListener('loomwatch:add-agent', added)
    palette()
    const yours = await waitFor(() => section('Your jobs'))
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings.indexOf('Your jobs')).toBeLessThan(headings.indexOf('Hire by job'))
    fireEvent.click(within(yours).getByRole('button', { name: /^Release notes/ }))
    const payload = JSON.parse((added.mock.calls[0][0] as CustomEvent<string>).detail)
    expect(payload).toMatchObject({ label: 'Release notes', role: 'Write the notes.', spawn: { cmd: 'codex' }, capabilities: [{ kind: 'skill', name: 'release-style' }] })
    window.removeEventListener('loomwatch:add-agent', added)
  })

  it('removes a saved job only on a second click', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', instructions: 'Write the notes.', file: '.jobs/release-notes.yaml' }]
    palette()
    const remove = await screen.findByRole('button', { name: 'Remove the job Release notes' })
    fireEvent.click(remove)
    expect(removed).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Release notes' }))
    await waitFor(() => expect(removed).toEqual(['release-notes']))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your jobs' })).toBeNull())
  })

  it('says which job file it could not read instead of hiding it', async () => {
    problems = [{ file: '.jobs/broken.yaml', message: 'A job needs instructions: what should the agent do?' }]
    palette()
    expect(await screen.findByText(/Can’t read \.jobs\/broken\.yaml/)).toBeInTheDocument()
  })
})

const capabilities: CapabilityInventory = {
  skills: [{ id: 'skill-notebooklm', name: 'notebooklm', source: 'Claude Code + Codex', detail: 'Research notebooks', status: 'Ready' }],
  tools: [{ id: 'tool-memory', name: 'Agent Memory', source: 'Claude Code + Codex', detail: 'Local MCP connector', status: 'Compatible' }],
  // Team memory is the only knowledge the daemon lists (ADR 0036).
  sources: [{ id: 'memory-research', name: 'Research team · memory', source: 'LoomWatch', detail: '1 brief entry', status: 'Ready', memory: { team: 'research-team', brief: 1 } }],
}

/** ADR 0041: the panels Build and the run trace drew were two components; this is the one left. */
describe('ComponentPalette in Build and in a run', () => {
  it('lists the same skills, tools and knowledge the local scan found, with their compatibility', () => {
    render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} capabilitiesScannedAt={new Date()} />)
    expect(within(section('Skills')).getByRole('button', { name: /notebooklm.*Claude Code \+ Codex.*Ready/ })).toBeInTheDocument()
    expect(within(section('Tools')).getByRole('button', { name: /Agent Memory.*Compatible/ })).toBeInTheDocument()
    expect(within(section('Team memory')).getByRole('button', { name: /Research team · memory/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/Scanned this Mac at/)
  })

  it('makes every row a real drag source with the payload the canvas reads', () => {
    const dragState = vi.fn()
    render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onDragStateChange={dragState} />)
    for (const [name, mime, payload] of [
      [/^Codex/, LIBRARY_DRAG_MIME, '"id":"codex"'],
      [/^notebooklm/, CAPABILITY_DRAG_MIME, '"kind":"skill"'],
      [/^Agent Memory/, CAPABILITY_DRAG_MIME, '"kind":"tool"'],
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
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onInspectCapability={inspect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details for notebooklm' }))
    expect(inspect).toHaveBeenCalledWith(capabilities.skills[0], 'skill')
    expect(placed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^notebooklm/ }))
    expect(JSON.parse((placed.mock.calls[0][0] as CustomEvent<string>).detail)).toMatchObject({ kind: 'skill', name: 'notebooklm' })
    window.removeEventListener('loomwatch:add-capability', placed)
  })

  it('says where built-in tools are switched on, since they are never listed as tools', () => {
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} />)
    expect(section('Tools')).not.toHaveTextContent('built into each AI app')
    fireEvent.click(within(section('Tools')).getByRole('button', { name: 'About Tools' }))
    expect(section('Tools')).toHaveTextContent('Web search, commands and file edits are built into each AI app instead: switch them on per agent, under Allowed without asking.')
  })

  // An empty group is one dashed slot, not a paragraph; why it is empty is behind its "?".
  it('shows an empty group as a single slot', () => {
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={{ skills: [], tools: [], sources: [] }} />)
    expect(section('Skills').querySelector('.palette-empty')).toHaveTextContent('None found on this Mac')
    expect(section('Tools').querySelector('.palette-empty')).toHaveTextContent('None found on this Mac')
    expect(section('Team memory').querySelector('.palette-empty')).toHaveTextContent('None yet')
  })

  /** ADR 0043: a folder or file is added from an agent's panel, so the add panel says where, and has no Add button of its own. */
  it('points Folders & files at the agent panel, with no Add folder of its own', () => {
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={{ ...capabilities, sources: [] }} />)
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
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onInspectCapability={inspect} onRevealSource={reveal} teamSources={[
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
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onRevealSource={reveal}
      notion={{ connection: { state: 'connected', workspace: 'Acme', destination: null }, pages: [{ id: item.id, name: 'Roadmap', page, readers: ['Researcher'], item }], onChoosePage: choose }} />)
    const connections = section('Connections')
    const notion = within(connections).getByRole('button', { name: /^Notion.*Drag onto an agent, then choose a page.*Acme/ })
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
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} notion={{ connection: { state: 'disconnected' }, pages: [] }} />)
    const notion = within(section('Connections')).getByRole('button', { name: /^Notion.*Not connected/ })
    expect(notion).toHaveAttribute('draggable', 'false')
    fireEvent.click(notion)
    expect(open).toHaveBeenCalledWith('/connections', '_blank', 'noopener')
  })

  /** The panel's right edge resizes it: dragged, with the arrow keys, and back to default on a double click. */
  it('resizes from its right edge, within its limits', () => {
    const onResize = vi.fn()
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} width={240} onResize={onResize} />)
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
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.queryByRole('separator', { name: 'Resize the panel' })).not.toBeInTheDocument()
  })

  it('shows a scan failure verbatim and scans again on request', () => {
    const scan = vi.fn()
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} capabilitiesError="EACCES ~/.claude/skills" onRetryCapabilities={scan} />)
    expect(screen.getByRole('alert')).toHaveTextContent('EACCES ~/.claude/skills')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan this computer again' }))
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('shows skeleton rows, never a spinner, while it looks for AI apps', () => {
    const { container } = render(<ComponentPalette harnesses={[]} harnessesLoading harnessesError={null} />)
    expect(section('AI apps').querySelectorAll('.skel-row')).toHaveLength(2)
    expect(container).not.toHaveTextContent('No AI apps found')
  })

  it('shows the daemon error about AI apps verbatim with a retry', () => {
    const retry = vi.fn()
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError="500: EACCES scanning /usr/local/bin" onRetry={retry} />)
    expect(within(section('AI apps')).getByRole('alert')).toHaveTextContent('500: EACCES scanning /usr/local/bin')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  // A harness can be installed and still unrunnable: `pi` ships no ACP bridge at all. The row
  // prints the daemon's sentence and cannot be added or dragged.
  it('prints the daemon reason for an app it cannot run, and will not add it', () => {
    const pi: DetectedHarness = { id: 'pi', name: 'pi', command: 'pi', executablePath: '/home/t/.local/bin/pi', acpAvailable: false, unavailableReason: 'pi is installed but ships no ACP bridge, so LoomWatch cannot drive it.', spawn: { cmd: 'pi', args: [] } }
    render(<ComponentPalette harnesses={[pi]} harnessesLoading={false} harnessesError={null} />)
    const row = within(section('AI apps')).getByRole('button', { name: /^pi.*ships no ACP bridge/ })
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('draggable', 'false')
  })

  it('names the apps it looked for and did not find, and where it looked', () => {
    render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} knownHarnessIds={['claude', 'codex', 'newharness']} harnessSearchPath={['/usr/bin', '/home/t/.local/bin']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not installed · 2' }))
    // The daemon owns the list, so an app this build has never heard of shows by its id.
    expect(section('AI apps')).toHaveTextContent('Claude, newharness')
    fireEvent.click(screen.getByRole('button', { name: 'Show search path' }))
    expect(screen.getByText('/home/t/.local/bin')).toBeInTheDocument()
  })

  it('shows the search path when no app was found, and says so when there was no PATH at all', () => {
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} harnessSearchPath={[]} />)
    expect(section('AI apps')).toHaveTextContent('No AI apps found on this Mac.')
    fireEvent.click(screen.getByRole('button', { name: 'Show search path' }))
    expect(screen.getByText(/started without a PATH/)).toBeInTheDocument()
  })

  it('folds on the shared events and ⌘\\ toggles it, as the run trace expects', () => {
    render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} />)
    act(() => { window.dispatchEvent(new Event('loomwatch:close-library')) })
    expect(screen.queryByRole('complementary', { name: 'Add to your team' })).toBeNull()
    act(() => { window.dispatchEvent(new Event('loomwatch:toggle-library')) })
    expect(screen.getByRole('complementary', { name: 'Add to your team' })).toBeInTheDocument()
  })
})

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString()
const event = (seq: number, agentId: string, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent => ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })
const refusedSearch = (seq: number, callId: string): RunEvent[] => [
  event(seq, 'researcher', 'tool_call', { callId, name: 'WebSearch', title: 'Web search', toolKind: 'fetch', status: 'pending', rawInput: {} }),
  event(seq + 1, 'researcher', 'permission', { options: [{ optionId: 'allow-once' }, { optionId: 'reject' }], toolCall: { kind: 'fetch', name: 'WebSearch', title: `Search "q${seq}"`, toolCallId: callId } }),
  event(seq + 2, 'researcher', 'permission', { outcome: { optionId: 'reject', outcome: 'selected' } }),
]

describe('ComponentPalette while a run is shown', () => {
  const evidence = projectRun([...refusedSearch(1, 's1'), ...refusedSearch(5, 's2'), event(9, 'researcher', 'tool_call', { callId: 'n1', name: 'mcp__notion__search', title: 'mcp__notion__search', toolKind: 'other', status: 'completed', rawInput: {} })]).evidence
  const names = new Map([['researcher', 'Researcher']])
  // What LoomWatch connected to the researcher, from its run record.
  const connected = new Map([['researcher', ['notion']]])

  it('leads with what the run used, one row per tool, saying why a built-in one was declined', () => {
    render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} observedEvidence={evidence} observedConnected={connected} agentNames={names} />)
    const used = section('Used in this run')
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings[0]).toBe('Used in this run')
    expect([...used.querySelectorAll('.palette-item')].map((button) => button.querySelector('strong')?.textContent)).toEqual(['Web search', 'notion · search'])
    expect(within(used).getByRole('button', { name: /^Web search/ })).toHaveTextContent('Built into the app · ResearcherDeclined 2×: Researcher isn’t allowed to search the web×2')
    fireEvent.click(within(used).getByRole('button', { name: 'About Used in this run' }))
    expect(used).toHaveTextContent('Switch them on per agent, under Allowed without asking.')
    // Never one row per permission answer, which the old Library listed as tools.
    expect(screen.queryByText(/^Search "/)).toBeNull()
  })

  it('reveals a row on the canvas, or lets it be dragged there to reposition the card', () => {
    const reveal = vi.fn()
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} observedEvidence={evidence} observedConnected={connected} agentNames={names} onRevealEvidence={reveal} />)
    const row = within(section('Used in this run')).getByRole('button', { name: /^notion · search/ })
    fireEvent.click(row)
    expect(reveal).toHaveBeenCalledWith('researcher:n1')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(EVIDENCE_DRAG_MIME, 'researcher:n1')
  })

  // ADR 0044: the row used to read "Artifact · Built into the app" like any harmless tool.
  it('says when an app tool reached past the run without asking', () => {
    const published = projectRun([event(1, 'researcher', 'tool_call', { callId: 'a1', name: 'Artifact', title: 'Artifact', toolKind: 'other', status: 'completed', rawInput: { action: 'publish' } })]).evidence
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} observedEvidence={published} agentNames={names} />)
    expect(within(section('Used in this run')).getByRole('button', { name: /^Artifact/ })).toHaveTextContent('Built into the app · ResearcherUsed without asking: publishes to your claude.ai account×1')
    // No switch lets it through, so the hint about switches would point nowhere.
    expect(within(section('Used in this run')).queryByRole('button', { name: 'About Used in this run' })).not.toBeInTheDocument()
  })

  // ADR 0047, run 4bb918c5: the ChatGPT app's `cua_repl`, which a Codex Gatherer called without
  // asking, read "Connected tool" as if the operator had connected it.
  it('says when a server the app brought, not one LoomWatch connected, ran without asking', () => {
    const repl = projectRun([
      event(1, 'researcher', 'tool_call', { callId: 'c1', title: 'mcp.cua_repl.js', toolKind: 'execute', status: 'in_progress', rawInput: { tool: 'js', server: 'cua_repl', arguments: { code: 'await cua.createBrowserTab("iab", "https://github.blog/")' } } }),
      event(2, 'researcher', 'tool_update', { callId: 'c1', status: 'failed' }),
    ]).evidence
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} observedEvidence={repl} observedConnected={connected} agentNames={names} />)
    expect(within(section('Used in this run')).getByRole('button', { name: /^cua_repl · js/ })).toHaveTextContent('Built into the app · ResearcherUsed without asking: controls the browser and apps on your computer×1')
  })

  it('names the folded panel after what a run reader opens it for', () => {
    render(<ComponentPalette harnesses={[]} harnessesLoading={false} harnessesError={null} observedEvidence={evidence} agentNames={names} />)
    act(() => { window.dispatchEvent(new Event('loomwatch:close-library')) })
    expect(screen.getByRole('button', { name: 'Used in this run · 2' })).toBeInTheDocument()
  })
})
