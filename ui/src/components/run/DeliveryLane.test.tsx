import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryLane, type DeliveryLaneProps } from './DeliveryLane'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { StatusGlyph } from '../ui/glyphs'

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useConnection: (selector: (connection: { inProgress: boolean }) => unknown) => selector({ inProgress: false }),
  useNodeId: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; type: string; data: unknown }>; nodeTypes: Record<string, ComponentType<{ data: unknown }>> }) => <>{nodes.map(node => createElement(nodeTypes[node.type], { key: node.id, data: node.data }))}</>,
}))
vi.mock('../agents/benchFigure', () => ({
  // The bench draws with WebGL, which jsdom hasn't got: a stand-in that shows what it was told to act out.
  AgentFigure: ({ view, who }: { view: { mood: string; phase?: string; thought?: string | null }; who?: string }) => (
    <div className="bench-told" data-who={who} data-mood={view.mood} data-phase={view.phase ?? ''} data-thought={view.thought ?? ''} />
  ),
}))
import { type Evidence, projectRun } from '../../lib/watch/events'
import type { AgentRuntime } from '../../lib/runs/graph'
import type { RunRecord } from '../../lib/runs/client'
import { background, cascaded } from '../../test/cascade'
import { apcaLc, THEMES, tokenColour, wcagRatio, type Theme } from '../../test/contrast'
const setup = (overrides: Partial<DeliveryLaneProps> = {}) => {
  const props: DeliveryLaneProps = {
    prompt: 'Research LoomWatch',
    attempt: 15,
    phase: 'succeeded',
    elapsed: '2m 53s',
    mode: 'replay',
    pipeline: true,
    agents: [
      {
        id: 'designer',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'Designer',
          agent: {
            id: 'designer',
            name: 'Designer',
            role: 'Design reports',
            capabilities: [{ kind: 'skill', name: 'claude-design' }],
          },
        },
      },
    ],
    evidenceByAgent: new Map(),
    projection: projectRun([]),
    onInspectEvidence: vi.fn(),
    onSelectAgent: vi.fn(),
    onShowRecorded: vi.fn(),
    output: {
      text: '# Market report\n\n| Finding | Impact |\n|---|---|\n| Clear results | Faster review |',
      producer: 'designer',
    },
    ...overrides,
  }
  const view = render(<DeliveryLane {...props} />)
  return { ...view, props }
}
afterEach(cleanup)
describe('Delivery Lane', () => {
  // ADR 0051: Details is the record of how the answer was made. The request, the answer and its
  // review are in the chat beside it, so none of them is repeated here.
  it('is the record only: no request, answer, review or second way to start work', () => {
    setup()
    expect(screen.queryByRole('complementary', { name: 'Team output' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Market report' })).toBeNull()
    expect(screen.queryByText('Request')).toBeNull()
    // The receipt still prints what was asked: it is a slip of the record, copied whole.
    expect(screen.queryByText('Research LoomWatch', { selector: 'p, h1, h2' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Review output|New run|Copy team output/ })).toBeNull()
    // How it went leads, stamped on the run's receipt under which run it was...
    const slip = screen.getByRole('region', { name: 'Run receipt' })
    expect(within(slip).getByRole('heading', { level: 1, name: 'Finished' })).toBeInTheDocument()
    expect(within(slip).getByText('Run 15')).toBeInTheDocument()
    // ...so no heading above the record says either again.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByText('2m 53s', { selector: '.delivery-took' })).toBeNull()
  })
  // The office sketches (owner, 2026-11-13): one tile per agent, at its own bench. What was asked and
  // what came back are read in the chat beside the record (ADR 0051), so no tile says either again.
  it('lays the team out as one tile per agent, at its own bench, without repeating the request or the answer', () => {
    const { props } = setup()
    const grid = screen.getByRole('list', { name: 'Team stages' })
    const items = within(grid).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    const tile = items[0].querySelector('.stage-tile') as HTMLElement
    expect(tile.querySelector('.bench-told')?.getAttribute('data-who')).toBe('designer')
    expect(tile.querySelector('.delivery-status')).toHaveTextContent(/Done|Finished|Ready|Not started/)
    // Who handed it its work, not the words: those are in the chat.
    expect(tile.querySelector('.stage-handed')).toHaveTextContent(/^Work from you$/)
    expect(grid).not.toHaveTextContent(props.prompt)
    expect(grid).not.toHaveTextContent('Market report')
    // The tiles wrap, so no team scrolls sideways. (Spelled in parts: Tailwind reads test files.)
    expect(cascaded(grid, ['grid', 'template', 'columns'].join('-'))).toMatch(/^repeat\(auto-fill, minmax\(/)
  })

  // ADR 0083, decision 10: work one of your agents asked for starts from that agent, as the chat
  // beside the record says, not from you.
  it('says the first tile’s work came from the agent that asked for it for you', () => {
    const record = { runId: 'r', askedBy: { agent: 'maya', name: 'Maya' } } as RunRecord
    setup({ record })
    const handed = document.getElementById('delivery-stage-designer')?.querySelector('.stage-handed') as HTMLElement
    expect(handed).toHaveTextContent(/^Work from Maya$/)
    expect(handed).toHaveAttribute('title', 'Maya asked this for you. You pressed Start.')
  })

  // A card had its model, its status and its name squeezed in beside the figure: a long model
  // ("GPT-6.1 Sol · ChatGPT plan") wrapped, and the status pill ran into the name under it.
  it('gives a tile’s card room: its name and status on one row, its model the full width under them', () => {
    setup()
    const who = document.getElementById('delivery-stage-designer')?.querySelector('.stage-who') as HTMLElement
    const [top, model] = [...who.children] as HTMLElement[]
    expect(top.querySelector('strong')).toHaveTextContent('Designer')
    expect(top.querySelector('.delivery-status')).toHaveTextContent(/Done|Finished|Ready|Not started/)
    expect(model).toHaveClass('flow-micro')
    expect(model.querySelector('.delivery-status')).toBeNull()
    // A status too long for the name's row takes the next one whole. (Spelled in parts: Tailwind
    // reads test files for class names.)
    expect(cascaded(who, 'display')).toBe('grid')
    expect(cascaded(top, ['flex', 'wrap'].join('-'))).toBe('wrap')
    expect(cascaded(top, 'justify-content')).toBe('space-between')
  })

  it('counts one stage and one page as one, not "1 stages" and "1 pages"', () => {
    const source = { id: 'e1', agentId: 'designer', kind: 'source', relation: 'consulted source', name: 'Read https://example.com/a', status: 'succeeded', toolKind: 'fetch', rawInput: { url: 'https://example.com/a' }, locations: [] } as unknown as Evidence
    setup({ evidenceByAgent: new Map([['designer', [source]]]) })
    expect(screen.getByText('1 stage · 1 deliverable')).toBeInTheDocument()
    // The count a person sees is the page count the receipt gives, not the number of calls.
    expect(screen.getByRole('button', { name: 'On the web: 1 page read' })).toHaveTextContent(/^1$/)
    expect(document.body).not.toHaveTextContent(/1 stages|1 pages|1 sources/)
  })

  /**
   * The run of 2026-10-21: the tutor's card said "24 sources" for 5 pages, 4 searches and 10 runs
   * of code. Its tray counts them apart, and its web list names each page once, by site, marking
   * the ones the team's answer links.
   */
  it('opens the pages a stage read and what it searched from its tray', () => {
    const item = (id: string, name: string, fields: Partial<Evidence>) => ({ id, agentId: 'designer', kind: 'source', relation: 'consulted source', name, status: 'succeeded', toolKind: 'fetch', rawInput: {}, locations: [], offsetMs: 0, content: null, rawOutput: null, ...fields }) as unknown as Evidence
    const said = (text: string) => [{ type: 'content', content: { type: 'text', text } }]
    const evidence = [
      item('s1', 'Search the web', { content: said('[1706.03762] Attention Is All You Need https://arxiv.org/abs/1706.03762') }),
      item('p1', 'Read a page', { content: said('Read https://arxiv.org/abs/1706.03762') }),
      item('p2', 'Read https://arxiv.org/pdf/1808.09781', { rawInput: { url: 'https://arxiv.org/pdf/1808.09781' } }),
      item('p3', 'Read a page', { content: said('Failed: url_not_in_prior_context') }),
      item('c1', 'Search the web: the web', { rawInput: { code: 'import json' } }),
    ]
    const { output } = setup().props
    cleanup()
    setup({ evidenceByAgent: new Map([['designer', evidence]]), output: { ...output, text: 'Built on https://arxiv.org/abs/1706.03762.' } })
    const card = document.getElementById('delivery-stage-designer') as HTMLElement
    // Searches, pages and the programs that ran them are one mark: one list, one control.
    expect(within(card).getAllByRole('button', { name: /^On the web/ })).toHaveLength(1)
    // Two pages it got, each once, as the receipt counts them; the failed read is not one.
    fireEvent.click(within(card).getByRole('button', { name: 'On the web: 2 pages read, 1 search' }))
    // The list opens under the row, so the card keeps its size beside the others.
    const list = screen.getByRole('region', { name: 'Designer: on the web' })
    expect(within(list).getByText('arxiv.org')).toBeInTheDocument()
    // A page a search listed goes by the title the search gave it; one it didn't, by its address.
    const [cited, found] = within(list).getAllByRole('link', { name: /Attention Is All You Need/ })
    expect(cited).toHaveAttribute('href', 'https://arxiv.org/abs/1706.03762')
    expect(cited.closest('li')).toHaveTextContent('In the answer')
    expect(within(list).getByRole('link', { name: /\/pdf\/1808\.09781/ }).closest('li')).not.toHaveTextContent('In the answer')
    expect(within(list).getByText('It didn’t keep what it searched for.')).toBeInTheDocument()
    expect(found.closest('.stage-found')).not.toBeNull()
    expect(list).toHaveTextContent('Pages that came back empty 1')
    expect(list).toHaveTextContent('Programs it ran to search the web 1')
  })

  it('says how a run is going in its heading until the receipt is printed', () => {
    setup({ phase: 'running', mode: 'live' })
    expect(screen.queryByRole('region', { name: 'Run receipt' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Running2m 53s')
  })
  // The skills & tools section folded into each stage's tray: a skill is reached from its mark.
  const openSkills = (required: number, opened = 0) => fireEvent.click(screen.getByRole('button', { name: `Opened or was given ${opened} of the ${required} ${required === 1 ? 'skill' : 'skills'} it must use.` }))
  it('inspects an unverified required skill', () => {
    setup()
    openSkills(1)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Inspect claude-design: Not opened',
      }),
    )
    expect(
      screen.getByText(/Nothing in this run shows it opening this skill/),
    ).toBeInTheDocument()
  })
  /**
   * ADR 0021's run-side half. Delivery was already visible; what the operator could not see was
   * whether the agent opened the file, and what LoomWatch told it about running the skill here.
   * Both are read from the daemon's own records — the route, the `skill_opened` phase, and the
   * archived `skill_translation` prompt section — never re-derived from prose.
   */
  it('shows the route, whether the skill was opened, and the note the agent was actually sent', () => {
    const skill = {
      name: 'claude-design',
      source: 'Claude Code',
      sourcePath: '/home/.claude/skills/claude-design/SKILL.md',
      path: '/work/.agents/skills/claude-design/SKILL.md',
      sha256: 'a'.repeat(64),
      chars: 200,
      route: 'inline',
    }
    const meta = (seq: number, payload: Record<string, unknown>) => ({
      id: `e${seq}`, sessionId: 'r', agentId: 'designer', seq,
      ts: `2026-09-20T10:00:0${seq}Z`, kind: 'session_meta' as const, payload,
      raw: { source: 'loomwatch' },
    })
    const projection = projectRun([
      meta(0, { phase: 'prompt_sections', requiredSkills: [skill], sections: [
        { kind: 'required_skill', heading: '## Required skill: claude-design', text: 'body' },
        { kind: 'skill_translation', heading: '## Reading claude-design on Codex', text: 'Scripts: LoomWatch refuses every permission request your harness makes.' },
      ] }),
      meta(1, { phase: 'required_skills_supplied', skills: [skill] }),
      meta(2, { phase: 'skill_opened', skill: 'claude-design', path: skill.path, sha256: skill.sha256, toolCallId: 'call-7' }),
      meta(3, { phase: 'skill_self_report', text: '## What I could not follow\n- the bundled script', chars: 47 }),
    ])
    setup({ projection })

    // The tray's skill mark opens its skills under the tiles, and folds them away again.
    openSkills(1, 1)
    expect(screen.getByRole('region', { name: 'Designer: skills' })).toHaveTextContent('claude-design')
    openSkills(1, 1)
    expect(screen.queryByRole('region', { name: 'Designer: skills' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Opened or was given 1 of the 1 skill it must use.' })).toHaveTextContent('1/1')
    expect(screen.getByRole('button', { name: 'Opened or was given 1 of the 1 skill it must use.' })).not.toHaveClass('short')
    openSkills(1, 1)
    fireEvent.click(screen.getByRole('button', { name: /Inspect claude-design: Opened/ }))
    expect(screen.getByText(/In-prompt, translated/)).toBeInTheDocument()
    expect(screen.getByText(/Its own record shows it opening the file it was given/)).toBeInTheDocument()
    expect(screen.getByText(/LoomWatch refuses every permission request/)).toBeInTheDocument()
    expect(screen.getByText(/the bundled script/)).toBeInTheDocument()
    expect(screen.getByText(/LoomWatch can’t confirm it/)).toBeInTheDocument()
  })

  /** The counterfactual: the same delivery with no recorded open must not claim one. */
  it('says plainly that an unopened skill was delivered and not opened', () => {
    const skill = {
      name: 'claude-design', source: 'Claude Code',
      sourcePath: '/home/.claude/skills/claude-design/SKILL.md',
      path: '/work/.agents/skills/claude-design/SKILL.md',
      sha256: 'a'.repeat(64), chars: 200, route: 'native',
    }
    const meta = (seq: number, payload: Record<string, unknown>) => ({
      id: `e${seq}`, sessionId: 'r', agentId: 'designer', seq,
      ts: `2026-09-20T10:00:0${seq}Z`, kind: 'session_meta' as const, payload,
      raw: { source: 'loomwatch' },
    })
    setup({ projection: projectRun([
      meta(0, { phase: 'prompt_sections', requiredSkills: [skill], sections: [] }),
      meta(1, { phase: 'required_skills_supplied', skills: [skill] }),
    ]) })

    // A required skill it never opened leaves its mark dashed.
    expect(screen.getByRole('button', { name: 'Opened or was given 0 of the 1 skill it must use.' })).toHaveClass('short')
    openSkills(1)
    fireEvent.click(screen.getByRole('button', { name: /Inspect claude-design: Not opened/ }))
    expect(screen.getByText(/Native — the bundle sits/)).toBeInTheDocument()
    expect(screen.getByText(/Being given a skill is not using it/)).toBeInTheDocument()
    cleanup()

    // Put whole into what it was sent, the same skill is one it had, though it never opened it.
    setup({ projection: projectRun([
      meta(0, { phase: 'prompt_sections', requiredSkills: [{ ...skill, route: 'inline' }], sections: [] }),
      meta(1, { phase: 'required_skills_supplied', skills: [{ ...skill, route: 'inline' }] }),
    ]) })
    expect(screen.getByRole('button', { name: 'Opened or was given 1 of the 1 skill it must use.' })).not.toHaveClass('short')
    openSkills(1, 1)
    expect(screen.getByRole('button', { name: 'Inspect claude-design: Given in full' })).toBeInTheDocument()
  })

  // Field report (2026-10-04): a team with no required skill showed "0/0 required loaded" and
  // "Loading evidence and output quality are separate checks.", which told a newcomer nothing.
  it('counts required skills only when the team has some', () => {
    const designer = setup().props.agents[0]
    cleanup()
    setup({ agents: [{ ...designer, data: { ...designer.data, agent: { ...designer.data.agent, capabilities: [] } } }] })
    expect(screen.queryByRole('button', { name: /^Skills/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/it must use/)).not.toBeInTheDocument()
    expect(screen.queryByText(/separate checks/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /What was recorded/ })).toBeInTheDocument()
    cleanup()

    setup()
    openSkills(1)
    expect(screen.getByText(/Opened or was given 0 of the 1 skill it must use/)).toBeInTheDocument()
    expect(screen.queryByText(/separate checks/)).toBeNull()
  })

  // The run is read here and in the chat; it is no longer drawn on a canvas of its own.
  it('offers no full trace, and no second way to what the record already shows', () => {
    setup()
    expect(screen.queryByRole('button', { name: /Full trace|See every event/ })).toBeNull()
    expect(screen.getByRole('button', { name: /What was recorded/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Request a change' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Inspect handoff/ })).toBeNull()
  })
  // One place per thing (ADR 0043): what a stage used is in its own tray, not in a second list below.
  it('has no separate skills and tools section to keep in step with the cards', () => {
    setup()
    expect(screen.queryByRole('region', { name: 'Skills and tools' })).toBeNull()
    expect(screen.queryByLabelText('Capability graph scope')).toBeNull()
    expect(screen.queryByRole('button', { name: /^\d+ sources?$/ })).toBeNull()
  })
  it('folds an open list away with Escape, and gives focus back to its mark', () => {
    setup()
    openSkills(1)
    fireEvent.click(screen.getByRole('button', {name: 'Inspect claude-design: Not opened'}))
    const receipt = screen.getByText(/Nothing in this run shows it opening this skill/)
    fireEvent.keyDown(receipt, {key: 'Escape'})
    expect(screen.queryByText(/Nothing in this run shows it opening this skill/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Designer: skills' })).toBeNull()
    expect(screen.getByRole('main', {name: 'Run workspace'})).toBeInTheDocument()
  })
  it('avoids sequence arrows for branching pipelines', () => {
    setup({linearPipeline: false, agents: ['a', 'b'].map((id) => ({id, type: 'agent', position: {x: 0, y: 0}, data: {label: id, agent: {id, name: id, role: 'Work'}}}))})
    expect(screen.queryByLabelText('Next pipeline stage')).toBeNull()
    expect(screen.getByRole('heading', {name: 'Team contributions'})).toBeInTheDocument()
  })
  it('keeps identical skills separate by owner, each in its own stage', () => {
    setup({agents: ['Researcher', 'Designer'].map((name) => ({id: name.toLowerCase(), type: 'agent', position: {x: 0, y: 0}, data: {label: name, agent: {id: name.toLowerCase(), name, role: 'Work', capabilities: [{kind: 'skill', name: 'claude-design'}]}}}))})
    const designer = document.getElementById('delivery-stage-designer') as HTMLElement
    fireEvent.click(within(designer).getByRole('button', { name: 'Opened or was given 0 of the 1 skill it must use.' }))
    expect(screen.getByRole('region', { name: 'Designer: skills' })).toHaveTextContent('claude-design')
    expect(screen.queryByRole('region', { name: 'Researcher: skills' })).toBeNull()
  })
  describe('the stage that is working', () => {
    const runtime = (status: AgentRuntime['status']) => ({ status, taskState: 'RUNNING', task: 'Writing', ownerLabel: '', live: status === 'running' }) as AgentRuntime
    const agents = (writerStatus: AgentRuntime['status']) => [
      { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research' }, runtime: runtime('succeeded') } },
      { id: 'writer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer', agent: { id: 'writer', name: 'Writer', role: 'Write' }, runtime: runtime(writerStatus) } },
    ] as DeliveryLaneProps['agents']
    const stage = (id: string) => document.getElementById(`delivery-stage-${id}`) as HTMLElement
    // What its bench was told to act out.
    const told = (id: string) => ({ ...(stage(id).querySelector('.bench-told') as HTMLElement).dataset })

    it('is marked, and at work at its bench, while the run is watched live', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).toHaveClass('live')
      expect(stage('writer')).toHaveClass('working')
      expect(stage('researcher')).not.toHaveClass('working')
      expect(told('writer').mood).toBe('working')
      expect(told('researcher').mood).toBe('done')
    })

    // Waiting on your answer to a permission it asked for, the agent is not at work: its card says so
    // in gold and holds still, as the figure glows, rather than glowing blue with "Waiting for you".
    it('waits in gold, not at work, while its permission request is open', () => {
      const asking = agents('running')
      asking[1].data = { ...asking[1].data, runtime: { ...(asking[1].data.runtime as AgentRuntime), taskState: 'WAITING' } }
      setup({ mode: 'live', phase: 'running', agents: asking })
      expect(stage('writer')).not.toHaveClass('working')
      // At its bench it looks to you, as it does in its own chat while it asks.
      expect(told('writer').mood).toBe('asking')
      const status = within(stage('writer')).getByText('Waiting for you')
      expect(status).toHaveClass('status-waiting')
      expect(cascaded(status, 'color')).toBe('var(--color-accent)')
    })

    // "Didn’t finish" was red words, which on the dark card pass 5.6:1 but read muddy (APCA
    // Lc 43). The words are ink; the red is the pill's edge and the failed mark before them, so the
    // status is never told by colour alone.
    it('says a stage stopped with a problem in words that read in both themes, marked in red', () => {
      const { container } = setup({ phase: 'failed', agents: agents('failed') })
      const words = within(stage('writer')).getByText('Didn’t finish')
      // What the words sit on: the nearest box with a fill of its own, the card.
      const fill = (element: Element) => { const value = background(element); return value && !/^(none|transparent)$/.test(value) ? value : null }
      let under: Element | null = words
      while (under && !fill(under)) under = under.parentElement
      expect(under).toBe(stage('writer'))
      // The app's dark shell sets its own card and ink (#17191C under the words), so each is measured.
      const shells = ['', 'lw-shell', 'lw-railed']
      const card = (theme: Theme) => tokenColour(fill(under!), theme, under!)
      for (const shell of shells) {
        container.className = shell
        for (const theme of THEMES) {
          const ink = tokenColour(cascaded(words, 'color'), theme, words)
          expect(Math.abs(apcaLc(ink, card(theme))), `${shell} ${theme}`).toBeGreaterThanOrEqual(75)
          expect(wcagRatio(ink, card(theme)), `${shell} ${theme}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      // The red that means wrong, where a shape needs 3:1 on the card: the edge, and the failed mark
      // the run's other views draw, a red disc with a ×, before the words.
      const mark = words.firstElementChild as SVGSVGElement | null
      expect(mark?.outerHTML).toBe(render(<StatusGlyph status="failed" size={10} />, { container: document.createElement('span') }).container.innerHTML)
      expect(words.firstChild).toBe(mark)
      // In line with them, where Tailwind's base would put an svg on a line of its own. (Spelled in
      // parts: Tailwind reads test files for class names.)
      expect(cascaded(mark!, 'display')).toBe(['inline', 'block'].join('-'))
      const red = (value: string | null, theme: Theme) => tokenColour(value, theme, words) === tokenColour('var(--color-alert)', theme, words)
      const edge = cascaded(words, ['border', 'border-color'])
      for (const shell of shells) {
        container.className = shell
        for (const theme of THEMES) {
          expect(red(edge, theme), `${shell} ${theme}`).toBe(true)
          expect(red(mark!.style.color, theme), `${shell} ${theme}`).toBe(true)
          expect(wcagRatio(tokenColour(mark!.style.color, theme, words), card(theme)), `${shell} ${theme}`).toBeGreaterThanOrEqual(3)
        }
      }
      // Only the status a person must act on wears a mark; Done is its words and its glow.
      expect(within(stage('researcher')).getByText('Done').querySelector('svg')).toBeNull()
    })

    it('settles once the stage finishes', () => {
      setup({ mode: 'live', phase: 'succeeded', agents: agents('succeeded') })
      expect(stage('writer')).not.toHaveClass('working')
      expect(told('writer').mood).toBe('done')
    })

    // Option A of the trace sketches: the figure acts out what it is at, and the call it is on is named.
    const handedOn = () => {
      const now = Date.now()
      const at = (ms: number) => new Date(now - ms).toISOString()
      const events = [
        { agentId: 'writer', kind: 'session_meta', payload: { phase: 'prompt_sections', sections: [{ kind: 'stage_results', heading: '## Results', text: 'Findings.' }] }, raw: { source: 'loomwatch', phase: 'prompt_sections' }, ts: at(1500) },
        { agentId: 'writer', kind: 'message', payload: { role: 'user', content: { type: 'text', text: 'Write it.' } }, ts: at(1400) },
        { agentId: 'writer', kind: 'tool_call', payload: { callId: 'w1', title: 'Read https://example.com/brief', toolKind: 'fetch', status: 'in_progress', rawInput: { url: 'https://example.com/brief' } }, ts: at(300) },
      ].map((event, seq) => ({ ...event, id: `w${seq}`, seq, sessionId: 'run' })) as unknown as Parameters<typeof projectRun>[0]
      const projection = projectRun(events)
      return { events, projection, evidenceByAgent: new Map([['writer', projection.evidence.filter((item) => item.agentId === 'writer')]]) }
    }
    it('acts out the call it is on at its bench, and names it over its head, while watched live', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...handedOn() })
      expect(told('writer')).toMatchObject({ mood: 'working', phase: 'tools' })
      expect(stage('writer').querySelector('.stage-says')).toHaveTextContent('Read example.com/brief')
      expect(told('researcher')).toMatchObject({ mood: 'done', phase: '' })
      expect(stage('researcher').querySelector('.stage-says')).toBeNull()
    })

    // What it is thinking about, its bench's own thought bubble says, over its head: the tile's bubble
    // is for the call it is on, so the two never say it twice.
    it('lets its bench say what it is thinking about', () => {
      const thinking = handedOn()
      const thought = { ...thinking.events[2], id: 'w8', seq: 8, kind: 'thought', ts: new Date().toISOString(), payload: { content: { type: 'text', text: '**Which day comes first**' } } }
      const events = [...thinking.events.slice(0, 2), thought] as typeof thinking.events
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...thinking, events })
      expect(told('writer')).toMatchObject({ mood: 'working', phase: 'thinking', thought: 'Which day comes first' })
      expect(stage('writer').querySelector('.stage-says')).toBeNull()
    })

    it('shows its last words over its head as it types them, while watched live', () => {
      const typing = handedOn()
      const said = { ...typing.events[2], id: 'w9', seq: 9, kind: 'message', ts: new Date().toISOString(), payload: { role: 'agent', content: { type: 'text', text: 'The guide opens with the first day.' } } }
      const events = [...typing.events, said] as typeof typing.events
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...typing, events })
      expect(stage('writer').querySelector('.stage-says .stage-said')).toHaveTextContent('The guide opens with the first day.')
      expect(told('writer').phase).toBe('typing')
    })

    // Who handed it its work opens what it received: one way to it (ADR 0043), not a second link. The
    // panel is told who that was, as the record says, rather than guessing the stage before it.
    it('opens what a stage received from the line that says who handed it over', () => {
      const onShowReceived = vi.fn()
      const handed = agents('running')
      handed[1].data = { ...handed[1].data, runtime: { ...(handed[1].data.runtime as AgentRuntime), received: 'Findings.' } }
      setup({ mode: 'live', phase: 'running', agents: handed, ...handedOn(), onShowReceived })
      const line = within(stage('writer')).getByRole('button', { name: /^Work from Researcher/ })
      expect(line).toHaveAttribute('title', 'What Writer was given')
      fireEvent.click(line)
      expect(onShowReceived).toHaveBeenCalledWith('writer', 'Researcher')
      expect(screen.queryByRole('button', { name: /What it received/ })).toBeNull()
    })

    // A step-by-step run stopped early: the stages it never reached won't start, so none says it will.
    it('says what a stage waits for only while the run can still reach it, and names your review as you', () => {
      const review = { id: 'review', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'You', agent: { id: 'review', name: 'You', role: 'Approve it', kind: 'operator' } } }
      const later = { id: 'checker', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Checker', agent: { id: 'checker', name: 'Checker', role: 'Check' } } }
      const team = [...agents('running'), review, later] as DeliveryLaneProps['agents']
      setup({ mode: 'live', phase: 'running', agents: team })
      expect(stage('checker').querySelector('.stage-handed')).toHaveTextContent('Starts after your review')
      cleanup()
      setup({ mode: 'replay', phase: 'failed', agents: team })
      expect(stage('checker').querySelector('.stage-handed')).toBeNull()
    })

    // A browser keeps only so many 3D views on a page and drops the oldest unannounced: past them, a
    // tile shows its agent's figure instead of a bench that might go blank.
    it('draws a bench for the first eight agents, and the figure for the rest', () => {
      const team = Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, type: 'agent', position: { x: 0, y: 0 }, data: { label: `Agent ${index}`, agent: { id: `a${index}`, name: `Agent ${index}`, role: 'Work' } } })) as DeliveryLaneProps['agents']
      setup({ agents: team })
      expect(stage('a7').querySelector('.bench-told')).not.toBeNull()
      expect(stage('a8').querySelector('.bench-told')).toBeNull()
      expect(stage('a8').querySelector('.stage-bench-still')).not.toBeNull()
    })

    // The spotlight (owner, 2026-11-13): who is talking to whom, in a sentence with their faces. The
    // stages in it stay lit and the rest dim, and its card opens what was said in the chat beside the
    // record (ADR 0051) rather than saying it again.
    it('spotlights a handover as it passes, and opens it in the chat', () => {
      const onRevealMessage = vi.fn()
      const passing = handedOn()
      const team = [...agents('running'), { id: 'checker', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Checker', agent: { id: 'checker', name: 'Checker', role: 'Check' } } }] as DeliveryLaneProps['agents']
      setup({ mode: 'live', phase: 'running', agents: team, ...passing, onRevealMessage })
      const card = screen.getByRole('button', { name: /Researcher.*hands the work to.*Writer/ })
      // The sentence says it: no word repeats it, and the words handed over stay in the chat.
      expect(card.querySelector('.talk-word')).toBeNull()
      expect(card).not.toHaveTextContent('Findings.')
      expect(stage('researcher')).not.toHaveClass('dim')
      expect(stage('writer')).not.toHaveClass('dim')
      expect(stage('checker')).toHaveClass('dim')
      // It hasn't started, and says what it waits for.
      expect(stage('checker').querySelector('.stage-handed')).toHaveTextContent('Starts after Writer')
      fireEvent.click(card)
      expect(onRevealMessage).toHaveBeenCalledWith(passing.projection.messages.find((message) => message.kind === 'handover')?.id)
    })

    it('spotlights a send-back in the send-back’s gold, and nothing once the run is over', () => {
      const recent = (seq: number) => new Date(Date.now() - 3000 + seq * 1000).toISOString()
      const meta = (seq: number, payload: Record<string, unknown>) => ({ id: `c${seq}`, sessionId: 'run', agentId: 'writer', seq, ts: recent(seq), kind: 'session_meta', payload, raw: { source: 'loomwatch', phase: payload.phase } })
      const checked = projectRun([
        meta(0, { phase: 'check_result', checked: 'researcher', round: 1, items: [{ item: 'Every claim has a source', verdict: 'not_met', evidence: '' }] }),
        meta(1, { phase: 'check_sent_back', to: 'researcher', round: 1 }),
      ] as unknown as Parameters<typeof projectRun>[0])
      // A third stage, outside the talk and not at work, is dimmed while it lasts.
      const third = { id: 'analyst', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Analyst', agent: { id: 'analyst', name: 'Analyst', role: 'Analyse' } } }
      setup({ mode: 'live', phase: 'running', agents: [...agents('running'), third] as DeliveryLaneProps['agents'], projection: checked, onRevealMessage: vi.fn() })
      const card = screen.getByRole('button', { name: /Writer.*sends the work back to.*Researcher/ })
      expect(card).toHaveClass('tone-back')
      expect(stage('analyst')).toHaveClass('dim')
      cleanup()
      setup({ mode: 'live', phase: 'succeeded', agents: [...agents('succeeded'), third] as DeliveryLaneProps['agents'], projection: checked, onRevealMessage: vi.fn() })
      expect(screen.queryByRole('button', { name: /sends the work back/ })).toBeNull()
      expect(stage('analyst')).not.toHaveClass('dim')
    })

    // Two talks close together squeezed two cards into the pane, and a stage lit by a talk no card
    // explained read as a mistake: the newest talk has the spotlight, and only its stages stay lit.
    it('spotlights one talk at a time, the newest', () => {
      const now = Date.now()
      const at = (ms: number) => new Date(now - ms).toISOString()
      const handed = (agentId: string, ms: number) => ({ agentId, kind: 'session_meta', payload: { phase: 'prompt_sections', sections: [{ kind: 'stage_results', heading: '## Results', text: 'Work.' }] }, raw: { source: 'loomwatch', phase: 'prompt_sections' }, ts: at(ms) })
      const events = [handed('writer', 4000), handed('checker', 1000)].map((event, seq) => ({ ...event, id: `h${seq}`, seq, sessionId: 'run' })) as unknown as Parameters<typeof projectRun>[0]
      const team = [
        { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research' }, runtime: runtime('succeeded') } },
        { id: 'writer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer', agent: { id: 'writer', name: 'Writer', role: 'Write' }, runtime: runtime('succeeded') } },
        { id: 'checker', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Checker', agent: { id: 'checker', name: 'Checker', role: 'Check' } , runtime: runtime('running') } },
      ] as DeliveryLaneProps['agents']
      setup({ mode: 'live', phase: 'running', agents: team, events, projection: projectRun(events), onRevealMessage: vi.fn() })
      expect(document.querySelectorAll('.talk-card')).toHaveLength(1)
      expect(screen.getByRole('button', { name: /Writer.*hands the work to.*Checker/ })).toBeInTheDocument()
      expect(stage('researcher')).toHaveClass('dim')
      expect(stage('writer')).not.toHaveClass('dim')
      expect(stage('checker')).not.toHaveClass('dim')
    })

    // Whoever is at work stays lit, in the talk or not: dimming it would hide what it is doing.
    it('keeps a stage at work lit while others talk', () => {
      const now = Date.now()
      const handed = { agentId: 'checker', kind: 'session_meta', payload: { phase: 'prompt_sections', sections: [{ kind: 'stage_results', heading: '## Results', text: 'Draft.' }] }, raw: { source: 'loomwatch', phase: 'prompt_sections' }, ts: new Date(now - 1000).toISOString() }
      const events = [{ ...handed, id: 'k0', seq: 0, sessionId: 'run' }] as unknown as Parameters<typeof projectRun>[0]
      const team = [
        { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research' }, runtime: runtime('running') } },
        { id: 'writer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer', agent: { id: 'writer', name: 'Writer', role: 'Write' }, runtime: runtime('succeeded') } },
        { id: 'checker', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Checker', agent: { id: 'checker', name: 'Checker', role: 'Check' }, runtime: runtime('running') } },
      ] as DeliveryLaneProps['agents']
      setup({ mode: 'live', phase: 'running', agents: team, events, projection: projectRun(events), onRevealMessage: vi.fn() })
      expect(screen.getByRole('button', { name: /Writer.*hands the work to.*Checker/ })).toBeInTheDocument()
      expect(stage('researcher')).toHaveClass('working')
      expect(stage('researcher')).not.toHaveClass('dim')
    })

    it('holds the figure still, and spotlights nothing, in a replay', () => {
      setup({ mode: 'replay', agents: agents('running'), ...handedOn() })
      expect(told('writer')).toMatchObject({ mood: 'still', phase: '' })
      expect(stage('writer').querySelector('.stage-says')).toBeNull()
      expect(document.querySelector('.talk-band')).toBeNull()
    })

    it('never moves in a replay, whatever the recorded status says', () => {
      setup({ mode: 'replay', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).not.toHaveClass('live')
      expect(stage('writer')).not.toHaveClass('working')
      expect(told('writer').mood).toBe('still')
    })
  })

  // lib/motion/lift.ts decides when; this is the Run view collecting it.
  // A required skill not yet opened is a gap only once the run is over: while it runs, it may still.
  it('leaves the skill mark solid while the run is still going', () => {
    setup({ mode: 'live', phase: 'running' })
    expect(screen.getByRole('button', { name: 'Opened or was given 0 of the 1 skill it must use.' })).not.toHaveClass('short')
    cleanup()
    setup({ phase: 'succeeded' })
    expect(screen.getByRole('button', { name: 'Opened or was given 0 of the 1 skill it must use.' })).toHaveClass('short')
  })

  it('reads a planned stage as ready', () => {
    setup({ planned: true })
    expect(within(document.getElementById('delivery-stage-designer') as HTMLElement).getByText('Ready')).toBeInTheDocument()
  })
})

describe('Delivery Lane messages between agents', () => {
  const ts = (seconds: number) => new Date(Date.parse('2026-10-05T09:00:00Z') + seconds * 1000).toISOString()
  const events = [
    { agentId: 'researcher', kind: 'process', payload: { phase: 'spawned', pid: 1 } },
    { agentId: 'writer', kind: 'session_meta', payload: { phase: 'prompt_sections', sections: [{ kind: 'stage_results', heading: '## Results', text: 'Findings: ACP is JSON-RPC.' }] }, raw: { source: 'loomwatch', phase: 'prompt_sections' } },
    { agentId: 'writer', kind: 'message', payload: { role: 'user', content: { type: 'text', text: 'prompt' } } },
    { agentId: 'writer', kind: 'tool_call', payload: { callId: 'q', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'researcher', question: 'Which version?' } } },
    { agentId: 'writer', kind: 'tool_update', payload: { callId: 'q', status: 'completed', rawOutput: { agent: 'researcher', reply: '0.4', live: true } } },
  ].map((event, seq) => ({ ...event, id: `e${seq}`, seq, sessionId: 'run', ts: ts(seq * 10) })) as unknown as Parameters<typeof projectRun>[0]
  const node = (id: string, name: string) => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: { label: name, agent: { id, name, role: name } } })

  // ADR 0051: what the agents said lives in the chat beside Details, not in it twice.
  it('leaves what the agents said to the chat, and reads a message there from the timeline', async () => {
    const onRevealMessage = vi.fn()
    setup({
      agents: [node('researcher', 'Researcher'), node('writer', 'Writer')] as unknown as DeliveryLaneProps['agents'],
      projection: projectRun(events),
      onRevealMessage,
    })
    expect(screen.queryByRole('region', { name: 'Team chat' })).not.toBeInTheDocument()
    const previous = screen.getByRole('button', { name: 'Previous moment' })
    for (let tries = 0; tries < events.length && !screen.queryByRole('button', { name: 'Read the message' }); tries += 1) fireEvent.click(previous)
    fireEvent.click(screen.getByRole('button', { name: 'Read the message' }))
    expect(onRevealMessage).toHaveBeenCalledWith(expect.any(String))
  })
})
