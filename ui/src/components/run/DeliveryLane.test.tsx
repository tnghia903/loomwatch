import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryLane, type DeliveryLaneProps } from './DeliveryLane'
import { CanvasActionsContext } from '../canvas/CanvasActionsContext'
import { createElement, type ComponentType, type ReactNode } from 'react'

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; type: string; data: unknown }>; nodeTypes: Record<string, ComponentType<{ data: unknown }>> }) => <>{nodes.map(node => createElement(nodeTypes[node.type], { key: node.id, data: node.data }))}</>,
}))
import { projectRun, type Evidence, type RunProjection } from '../../lib/watch/events'
import type { AgentRuntime } from '../../lib/runs/graph'
import { markLiftOrigin, noteShownRequest } from '../../lib/motion/lift'
const setup = (overrides: Partial<DeliveryLaneProps> = {}) => {
  const actions = {
    renameAgent: vi.fn(),
    touchField: vi.fn(),
    mode: 'pipeline' as const,
    stepById: new Map(),
    nodeNames: new Map(),
    toggleProvenance: vi.fn(),
    focusComposer: vi.fn(),
  }
  const props: DeliveryLaneProps = {
    prompt: 'Research LoomWatch',
    attempt: 15,
    phase: 'succeeded',
    branch: 'Initial run',
    elapsed: '2m 53s',
    mode: 'replay',
    pipeline: true,
    onTrace: vi.fn(),
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
    ownerLabels: new Map(),
    projection: projectRun([]),
    selectedEvidenceId: null,
    onInspectEvidence: vi.fn(),
    onSelectAgent: vi.fn(),
    output: {
      text: '# Market report\n\n| Finding | Impact |\n|---|---|\n| Clear results | Faster review |',
      phase: 'succeeded',
      phaseText: 'Answered',
      producer: 'designer',
      producerLabel: 'Designer',
      mode: 'replay',
      streaming: false,
      pending: false,
      strip: null,
      compact: false,
      expanded: false,
      terminal: true,
    },
    ...overrides,
  }
  const view = render(
    <CanvasActionsContext.Provider value={actions}>
      <DeliveryLane {...props} />
    </CanvasActionsContext.Provider>,
  )
  return { ...view, props, actions }
}
afterEach(cleanup)
describe('Delivery Lane', () => {
  it('keeps the output visible while inspecting an unverified required skill', () => {
    setup()
    expect(
      within(
        screen.getByRole('complementary', { name: 'Team output' }),
      ).getByRole('heading', { name: 'Market report', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Inspect claude-design: Load unverified',
      }),
    )
    expect(
      screen.getByText(/No matching read receipt was captured/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Market report', level: 1 }),
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

    expect(screen.getByText('1/1 opened')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Inspect claude-design: Delivered → opened/ }))
    expect(screen.getByText(/In-prompt, translated/)).toBeInTheDocument()
    expect(screen.getByText(/its own stream shows it reading the delivered file/)).toBeInTheDocument()
    expect(screen.getByText(/LoomWatch refuses every permission request/)).toBeInTheDocument()
    expect(screen.getByText(/the bundled script/)).toBeInTheDocument()
    expect(screen.getByText(/It is not evidence of what happened/)).toBeInTheDocument()
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

    expect(screen.getByText('0/1 opened')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Inspect claude-design: Delivered, pointer in prompt/ }))
    expect(screen.getByText(/Native — the bundle sits/)).toBeInTheDocument()
    expect(screen.getByText(/Delivery is not use/)).toBeInTheDocument()
  })

  it('distinguishes missing output from a successful process and disables copying', () => {
    const { props } = setup({
      output: {
        text: '',
        phase: 'succeeded',
        phaseText: 'No text was captured',
        producer: 'designer',
        producerLabel: 'Designer',
        mode: 'replay',
        streaming: false,
        pending: false,
        strip: null,
        compact: false,
        expanded: false,
        terminal: true,
      },
    })
    expect(props.phase).toBe('succeeded')
    expect(
      screen.getByRole('heading', { name: 'No response produced' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copy team output' }),
    ).toBeNull()
  })
  // ADR 0043: the receipt's See every event and the answer's own Full trace link did what the
  // heading's Full trace does, and Request a change only focused the box that is already there.
  it('opens the full trace from one button, with no second way to the same place', () => {
    const { props } = setup()
    expect(screen.getAllByRole('button', { name: /Full trace|See every event/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Full trace' }))
    expect(props.onTrace).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Request a change' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Inspect handoff/ })).toBeNull()
  })
  it('does not allow review acknowledgement to bypass missing skill evidence', () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }))
    const review = within(screen.getByRole('dialog', { name: 'Review team output' }))
    fireEvent.click(review.getByRole('checkbox'))
    expect(review.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled()
    fireEvent.click(review.getByRole('button', { name: 'Keep reading' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('records a review only after the user checks the acknowledgement', () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    setup({ agents: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }))
    const review = within(screen.getByRole('dialog', { name: 'Review team output' }))
    expect(review.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled()
    fireEvent.click(review.getByRole('checkbox'))
    fireEvent.click(review.getByRole('button', { name: 'Mark reviewed' }))
    expect(screen.getByRole('button', { name: 'View review' })).toBeInTheDocument()
    expect(screen.getByText('Reviewed by you', { selector: '.delivery-output-badge' })).toBeInTheDocument()
  })
  // The badge beside the answer's title read "Response available" over a response already in
  // view. It now says what the run's record holds to check, and opens the review that lists it.
  it('says what is worth a look beside the answer, and opens the review on it', () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    const refused = { id: 'p1', agentId: 'designer', seq: 1, offsetMs: 0, kind: 'permission', relation: 'asked permission for', name: 'Web search', status: 'rejected', target: null, rawInput: { toolCall: { kind: 'fetch' } } } as unknown as Evidence
    const projection = { ...projectRun([]), agents: [{ id: 'designer', status: 'succeeded', openCalls: 0, exitCode: null, stopReason: null, requiredSkills: [] }] } as unknown as RunProjection
    const { props } = setup({ projection, evidenceByAgent: new Map([['designer', [refused]]]) })
    const output = within(screen.getByRole('complementary', { name: 'Team output' }))
    expect(output.queryByText(/Response available/i)).toBeNull()
    expect(output.getByText('Designer wasn’t allowed to search the web, and carried on without it.')).toBeInTheDocument()
    // The verdict is a status; Review output in the heading is the one way into the review (ADR 0043).
    expect(output.queryByRole('button', { name: /review this answer/ })).toBeNull()
    expect(output.getByText('1 thing to check')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Review output/ }))
    const review = within(screen.getByRole('dialog', { name: 'Review team output' }))
    fireEvent.click(within(review.getByRole('region', { name: 'Worth a look' })).getByRole('button', { name: /^Open: Designer wasn’t allowed/ }))
    expect(props.onInspectEvidence).toHaveBeenCalledWith('p1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('says nothing was flagged when the record holds nothing to check', () => {
    setup({ agents: [] })
    expect(screen.getByText('Nothing flagged')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /review this answer/ })).toBeNull()
    expect(screen.getByText('Every step finished and nothing in the record was flagged.')).toBeInTheDocument()
  })
  // A linked folder read as a file (EISDIR), then the files in it, read as "1 thing to check"; and
  // a clean run "read 1 source", which was your own answer at the review stop.
  it('neither flags a folder whose files were read nor counts your answer as a source', () => {
    const folder = '/Users/Shared/harbor-pine/q3-reports'
    const read = (id: string, path: string, status = 'succeeded') => ({ id, agentId: 'researcher', seq: 1, offsetMs: 0, kind: 'file', relation: 'read file', name: `Read ${path}`, status, toolKind: 'read', rawInput: { file_path: path }, locations: [{ path, line: 1 }], target: null }) as unknown as Evidence
    const answer = { id: 'a1', agentId: 'review', seq: 9, offsetMs: 0, kind: 'source', relation: 'directed', name: 'Your answer', status: 'succeeded', toolKind: null, rawInput: null, locations: [], target: null } as unknown as Evidence
    const projection = { ...projectRun([]), agents: [{ id: 'researcher', status: 'succeeded', openCalls: 0, exitCode: null, stopReason: null, requiredSkills: [] }] } as unknown as RunProjection
    setup({
      projection,
      agents: [{ id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Find what changed' } } }],
      evidenceByAgent: new Map([
        ['researcher', [read('r0', folder, 'failed'), ...['README.md', 'q3-sales.md', 'q3-churn.md'].map((file, index) => read(`r${index + 1}`, `${folder}/${file}`))]],
        ['review', [answer]],
      ]),
    })
    const output = within(screen.getByRole('complementary', { name: 'Team output' }))
    expect(output.getByText('Nothing flagged')).toBeInTheDocument()
    expect(output.getByText('Every step finished, reading 3 files, and nothing in the record was flagged.')).toBeInTheDocument()
  })
  it('supports filters and output expansion without changing the team', () => {
    const { container, props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(
      screen.getByText('No capabilities match this filter.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand team output' }))
    expect(container.querySelector('.delivery-lane')).toHaveClass(
      'output-expanded',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore split view' }))
    expect(container.querySelector('.delivery-lane')).not.toHaveClass(
      'output-expanded',
    )
    expect(props.agents[0].data.agent.capabilities).toEqual([
      { kind: 'skill', name: 'claude-design' },
    ])
  })
  it('copies the exact Markdown and unwinds evidence before leaving the Run view', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}})
    const {props} = setup()
    fireEvent.click(screen.getByRole('button', {name: 'Copy team output'}))
    expect(writeText).toHaveBeenCalledWith(props.output.text)
    expect(await screen.findByText('Response copied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Inspect claude-design: Load unverified'}))
    const back = screen.getByRole('button', {name: '← Back to graph'})
    expect(back).toHaveFocus()
    fireEvent.keyDown(back, {key: 'Escape'})
    expect(screen.queryByRole('heading', {name: 'claude-design'})).toBeNull()
    expect(screen.getByRole('main', {name: 'Run workspace'})).toBeInTheDocument()
  })
  it('avoids sequence arrows for branching pipelines', () => {
    setup({linearPipeline: false, agents: ['a', 'b'].map((id) => ({id, type: 'agent', position: {x: 0, y: 0}, data: {label: id, agent: {id, name: id, role: 'Work'}}}))})
    expect(screen.queryByLabelText('Next pipeline stage')).toBeNull()
    expect(screen.getByRole('heading', {name: 'Team contributions'})).toBeInTheDocument()
  })
  it('keeps identical skills separate by owner in the whole-team graph', () => {
    setup({agents: ['Researcher', 'Designer'].map((name) => ({id: name.toLowerCase(), type: 'agent', position: {x: 0, y: 0}, data: {label: name, agent: {id: name.toLowerCase(), name, role: 'Work', capabilities: [{kind: 'skill', name: 'claude-design'}]}}}))})
    fireEvent.change(screen.getByLabelText('Capability graph scope'), {target: {value: 'team'}})
    expect(screen.getByRole('button', {name: 'Inspect claude-design: Load unverified · Researcher'})).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Inspect claude-design: Load unverified · Designer'}))
    expect(screen.getByText('Designer', {selector: '.delivery-receipt-owner'})).toBeInTheDocument()
    expect(screen.getByRole('heading', {name: 'Market report', level: 1})).toBeInTheDocument()
  })
  it('puts a file the reply names in the output header, ready to open', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      path: '/teams/.loomwatch/demo/designer/report.docx', name: 'report.docx', exists: true, isDir: false, sizeBytes: 2048,
      modifiedAt: null, kind: 'document', folder: '.loomwatch/demo/designer', openable: true,
    })))))
    const { container } = setup({
      output: {
        text: 'Done.\n\n**File:** `/teams/.loomwatch/demo/designer/report.docx`',
        phase: 'succeeded', phaseText: 'Answered', producer: 'designer', producerLabel: 'Designer', mode: 'replay',
        streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: true,
      },
    })
    const files = screen.getByRole('group', { name: 'Files in this reply' })
    expect(within(files).getByRole('button', { name: 'Open report.docx' })).toHaveTextContent('Open document')
    expect(within(files).getByText('Report')).toBeInTheDocument()
    // The file sits in the Designer's workspace, so the card credits the Designer by name.
    expect(await within(files).findByText('Made by Designer · demo')).toBeInTheDocument()
    expect(container.querySelector('.delivery-response .file-chip')).not.toBeNull()
    vi.unstubAllGlobals()
  })
  it('does not execute raw HTML or load embedded remote images in a report', () => {
    const { container } = setup({
      output: {
        text: '<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)',
        phase: 'succeeded',
        phaseText: 'Answered',
        producer: 'designer',
        producerLabel: 'Designer',
        mode: 'replay',
        streaming: false,
        pending: false,
        strip: null,
        compact: false,
        expanded: false,
        terminal: true,
      },
    })
    expect(container.querySelector('.delivery-response script')).toBeNull()
    expect(container.querySelector('.delivery-response img')).toBeNull()
    expect(screen.getByText('[Image: tracking]')).toBeInTheDocument()
  })

  // A planned stage used to read "Ready" even when its app was not on this computer, while the
  // composer beneath it refused to run for exactly that reason.
  // The breathing perimeter and the handoff sweep (styles/motion.css) hang off these classes.
  describe('the stage that is working', () => {
    const runtime = (status: AgentRuntime['status']) => ({ status, taskState: 'RUNNING', task: 'Writing', ownerLabel: '', live: status === 'running' }) as AgentRuntime
    const agents = (writerStatus: AgentRuntime['status']) => [
      { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research' }, runtime: runtime('succeeded') } },
      { id: 'writer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer', agent: { id: 'writer', name: 'Writer', role: 'Write' }, runtime: runtime(writerStatus) } },
    ] as DeliveryLaneProps['agents']
    const stage = (id: string) => document.getElementById(`delivery-stage-${id}`) as HTMLElement
    // The arrow into a stage only shows the order; what the agent received opens from its card (ADR 0043).
    const handoffInto = (id: string) => stage(id).closest('.delivery-stage-wrap')?.querySelector('.delivery-handoff-arrow') as HTMLElement

    it('is marked, with the handoff into it, while the run is watched live', () => {
      setup({ mode: 'live', phase: 'running', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).toHaveClass('live')
      expect(stage('writer')).toHaveClass('working')
      expect(stage('researcher')).not.toHaveClass('working')
      expect(handoffInto('writer')).toHaveClass('passing')
    })

    it('settles once the stage finishes', () => {
      setup({ mode: 'live', phase: 'succeeded', agents: agents('succeeded') })
      expect(stage('writer')).not.toHaveClass('working')
      expect(handoffInto('writer')).not.toHaveClass('passing')
    })

    it('never moves in a replay, whatever the recorded status says', () => {
      setup({ mode: 'replay', agents: agents('running') })
      expect(screen.getByRole('main', { name: 'Run workspace' })).not.toHaveClass('live')
      expect(stage('writer')).not.toHaveClass('working')
      expect(handoffInto('writer')).not.toHaveClass('passing')
    })
  })

  // lib/motion/lift.ts decides when; this is the Run view collecting it.
  describe('the request the composer just sent', () => {
    afterEach(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate
      document.querySelectorAll('.lift-ghost').forEach((ghost) => ghost.remove())
    })

    it('lifts into the Request box of the run it started', () => {
      HTMLElement.prototype.animate = vi.fn(() => ({ finished: Promise.resolve() }) as unknown as Animation)
      noteShownRequest('An earlier request')
      markLiftOrigin(document.body.appendChild(document.createElement('textarea')), 'Research LoomWatch')
      setup({ mode: 'live', phase: 'running' })
      expect(document.querySelector('.lift-ghost')).toHaveTextContent('Research LoomWatch')
      // The copy flies, and the real line stays hidden until it lands.
      expect(HTMLElement.prototype.animate).toHaveBeenCalledTimes(2)
    })
  })

  describe('a planned stage whose app is not on this computer', () => {
    const sentence = 'Designer’s app “acme-agent-cli” isn’t installed on this computer.'
    const stage = () => document.getElementById('delivery-stage-designer') as HTMLElement

    it('says it cannot start, and why', () => {
      setup({ planned: true, appProblems: new Map([['designer', sentence]]) })
      expect(within(stage()).getByText('Can’t start')).toHaveClass('delivery-status', 'status-failed')
      expect(within(stage()).getByText(sentence)).toHaveClass('delivery-stage-problem')
      expect(within(stage()).queryByText('Ready')).not.toBeInTheDocument()
    })

    it('is ready when its app is here', () => {
      setup({ planned: true })
      expect(within(stage()).getByText('Ready')).toBeInTheDocument()
      expect(stage().querySelector('.delivery-stage-problem')).toBeNull()
    })

    // A run that happened has its own state; a pre-run check says nothing about it.
    it('is not marked on a run that already happened', () => {
      setup({ appProblems: new Map([['designer', sentence]]) })
      expect(within(stage()).queryByText('Can’t start')).not.toBeInTheDocument()
      expect(within(stage()).queryByText(sentence)).not.toBeInTheDocument()
    })
  })
})
