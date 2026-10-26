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
import { type Evidence, projectRun } from '../../lib/watch/events'
import type { AgentRuntime } from '../../lib/runs/graph'
import { appRules, background, cascaded, px, topLevel } from '../../test/cascade'
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
  // Option A of the trace sketches: one row from your request to the team's answer. Its ends say
  // where the work starts and ends, not the words again (ADR 0051): those are read in the chat.
  it('lays the team out in one row from your request to the answer, without repeating either', () => {
    const { props } = setup()
    const row = screen.getByRole('list', { name: 'Team stages' })
    const items = within(row).getAllByRole('listitem')
    expect([items[0], items[2]].map((item) => item.querySelector('.flow-micro')?.textContent)).toEqual(['Your request', 'The team’s answer'])
    expect(items[1].querySelector('.delivery-status')).toHaveTextContent(/Done|Finished|Ready|Not started/)
    expect(row).toHaveTextContent('From you')
    expect(row).toHaveTextContent('In the chat')
    expect(row).not.toHaveTextContent(props.prompt)
    expect(row).not.toHaveTextContent('Market report')
    cleanup()
    setup({ output: { ...props.output, text: '' } })
    expect(screen.getByRole('list', { name: 'Team stages' })).toHaveTextContent('Appears when the team is done.')
  })

  // A card had its model, its status and its name squeezed in beside the figure: a long model
  // ("GPT-6.1 Sol · ChatGPT plan") wrapped, and the status pill ran into the name under it.
  it('gives a card room: its status beside the figure, its model and name the full width under them', () => {
    setup()
    const card = within(screen.getByRole('list', { name: 'Team stages' })).getAllByRole('listitem')[1].querySelector('.flow-agent') as HTMLElement
    const who = card.querySelector('.flow-who') as HTMLElement
    const [top, model, name] = [...who.children] as HTMLElement[]
    expect(top.querySelector('.stage-figure')).not.toBeNull()
    expect(top.querySelector('.delivery-status')).toHaveTextContent(/Done|Finished|Ready|Not started/)
    expect(model).toHaveClass('flow-micro')
    expect(model.querySelector('.delivery-status')).toBeNull()
    expect(name.tagName).toBe('STRONG')
    // One under another, not beside the figure; a status too long for the top row takes the next one
    // whole, starting under the figure. (Spelled in parts: Tailwind reads test files for class names.)
    expect(cascaded(who, 'display')).toBe('grid')
    expect(cascaded(top, ['flex', 'wrap'].join('-'))).toBe('wrap')
    expect(cascaded(top, 'justify-content')).toBe('space-between')
  })

  // The line into the answer ran 44px under the others: the end's top padding pushed its line down too.
  it('keeps every line the work moves along at one height, the answer’s too', () => {
    setup()
    const links = [...screen.getByRole('list', { name: 'Team stages' }).querySelectorAll('.flow-link')]
    expect(links.length).toBeGreaterThan(1)
    for (const link of links) expect(cascaded(link.closest('.flow-node') as HTMLElement, ['padding', 'padding-top'])).toBeNull()
    // The lines meet the figures' middle: a figure and the review step's taller mark stand in one slot.
    for (const figure of document.querySelectorAll('.flow-top .stage-figure')) expect(cascaded(figure, 'height')).toBe('var(--flow-figure)')
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

    // Its skill hangs under its card, ticked, and opens the same receipt.
    const hanging = screen.getByRole('button', { name: 'Skill claude-design, opened' })
    expect(hanging).toHaveClass('had')
    fireEvent.click(hanging)
    expect(screen.getByRole('region', { name: 'Designer: skills' })).toHaveTextContent(/In-prompt, translated/)
    // The tray's skill mark folds the same list away.
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
    expect(screen.getByRole('button', { name: 'Skill claude-design' })).not.toHaveClass('had')
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
    // The arrow into a stage only shows the order; what the agent received opens from its card (ADR 0043).
    const handoffInto = (id: string) => stage(id).closest('.flow-node')?.querySelector('.flow-link') as HTMLElement

    it('is marked, with the handoff into it, while the run is watched live', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).toHaveClass('live')
      expect(stage('writer')).toHaveClass('working')
      expect(stage('researcher')).not.toHaveClass('working')
      expect(handoffInto('writer')).toHaveClass('passing')
    })

    // Waiting on your answer to a permission it asked for, the agent is not at work: its card says so
    // in gold and holds still, as the figure glows, rather than glowing blue with "Waiting for you".
    it('waits in gold, not at work, while its permission request is open', () => {
      const asking = agents('running')
      asking[1].data = { ...asking[1].data, runtime: { ...(asking[1].data.runtime as AgentRuntime), taskState: 'WAITING' } }
      setup({ mode: 'live', phase: 'running', agents: asking })
      expect(stage('writer')).not.toHaveClass('working')
      expect(handoffInto('writer')).not.toHaveClass('passing')
      const status = within(stage('writer')).getByText('Waiting for you')
      expect(status).toHaveClass('status-waiting')
      expect(cascaded(status, 'color')).toBe('var(--color-accent)')
    })

    // "Stopped with a problem" was red words, which on the dark card pass 5.6:1 but read muddy (APCA
    // Lc 43). The words are ink; the red is the pill's edge and the failed mark before them, so the
    // status is never told by colour alone.
    it('says a stage stopped with a problem in words that read in both themes, marked in red', () => {
      const { container } = setup({ phase: 'failed', agents: agents('failed') })
      const words = within(stage('writer')).getByText('Stopped with a problem')
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
      expect(handoffInto('writer')).not.toHaveClass('passing')
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
    it('acts out the call it is on, and names it, while watched live', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...handedOn() })
      const figure = stage('writer').querySelector('.stage-figure') as HTMLElement
      expect(figure.dataset.phase).toBe('tools')
      expect(figure.dataset.glow).toBe('working')
      // What it is on floats over its card, as the sketch drew it.
      expect(within(stage('writer').closest('.flow-column')?.querySelector('.flow-above') as HTMLElement).getByText('Read example.com/brief')).toBeInTheDocument()
      expect((stage('researcher').querySelector('.stage-figure') as HTMLElement).dataset).toMatchObject({ glow: 'done' })
      expect((stage('researcher').querySelector('.stage-figure') as HTMLElement).dataset.phase).toBeUndefined()
    })
    // Its thought floats over its card, so the bubble's tail comes up from the figure under it: two
    // dots below the bubble, the smaller one lower, nearer the figure. It used to leave the bubble's top.
    it('trails a thought up from the figure under it', () => {
      const dot = (which: 'before' | 'after') => Object.fromEntries(appRules
        .filter((rule) => rule.media.length === 0 && topLevel(rule.selectors).includes(`.stage-now.thought::${which}`))
        .flatMap((rule) => rule.body.split(';').map((declaration) => declaration.split(':').map((part) => part.trim())))
        .filter(([property, value]) => property && value))
      const below = (value: string) => Number(/^calc\(100% \+ (\d+)px\)$/.exec(value)?.[1] ?? NaN)
      const [near, far] = [dot('before'), dot('after')]
      expect(below(near.top)).toBeGreaterThan(0)
      expect(below(far.top)).toBeGreaterThan(below(near.top) + px(near.height))
      expect(px(far.width)).toBeLessThan(px(near.width))
      // Inside the bubble's left edge, over the figure, not out to its side.
      expect(px(near.left)).toBeGreaterThan(0)
      expect(px(far.left)).toBeGreaterThan(0)
    })
    it('carries the work along the handoff arrow just as it passes on', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...handedOn() })
      expect(handoffInto('writer').dataset.pass).toBe('on')
      expect(handoffInto('writer').querySelector('.handoff-sheet')).not.toBeNull()
    })
    // A send-back leaves a dashed arc under the line it went back along, for as long as the record shows.
    it('marks the line a check sent the work back along', () => {
      const meta = (seq: number, payload: Record<string, unknown>) => ({ id: `c${seq}`, sessionId: 'run', agentId: 'writer', seq, ts: new Date(Date.UTC(2026, 9, 21, 9, 0, seq)).toISOString(), kind: 'session_meta', payload, raw: { source: 'loomwatch', phase: payload.phase } })
      const checked = projectRun([
        meta(0, { phase: 'check_result', checked: 'researcher', round: 1, items: [{ item: 'Every claim has a source', verdict: 'not_met', evidence: '' }] }),
        meta(1, { phase: 'check_sent_back', to: 'researcher', round: 1 }),
      ] as unknown as Parameters<typeof projectRun>[0])
      setup({ mode: 'replay', agents: agents('succeeded'), projection: checked })
      expect(handoffInto('writer').querySelector('.flow-back')).not.toBeNull()
      cleanup()
      setup({ mode: 'replay', agents: agents('succeeded') })
      expect(handoffInto('writer').querySelector('.flow-back')).toBeNull()
    })

    it('shows its last words as it types them, while watched live', () => {
      const typing = handedOn()
      const said = { ...typing.events[2], id: 'w9', seq: 9, kind: 'message', ts: new Date().toISOString(), payload: { role: 'agent', content: { type: 'text', text: 'The guide opens with the first day.' } } }
      const events = [...typing.events, said] as typeof typing.events
      setup({ mode: 'live', phase: 'running', agents: agents('running'), ...typing, events })
      expect(stage('writer').querySelector('.flow-said')).toHaveTextContent('The guide opens with the first day.')
      expect((stage('writer').querySelector('.stage-figure') as HTMLElement).dataset.phase).toBe('typing')
    })

    it('holds the figure and the arrow still in a replay', () => {
      setup({ mode: 'replay', agents: agents('running'), ...handedOn() })
      expect((stage('writer').querySelector('.stage-figure') as HTMLElement).dataset.phase).toBeUndefined()
      expect(within(stage('writer').closest('.flow-column') as HTMLElement).queryByText('Read example.com/brief')).toBeNull()
      expect(handoffInto('writer').dataset.pass).toBeUndefined()
    })

    it('never moves in a replay, whatever the recorded status says', () => {
      setup({ mode: 'replay', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).not.toHaveClass('live')
      expect(stage('writer')).not.toHaveClass('working')
      expect(handoffInto('writer')).not.toHaveClass('passing')
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
