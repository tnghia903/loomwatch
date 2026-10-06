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
import { projectRun } from '../../lib/watch/events'
import type { AgentRuntime } from '../../lib/runs/graph'
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
    // How it went leads, with how long it took; which run it was is the label above.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Finished2m 53s')
    expect(screen.getByText('Run 15')).toBeInTheDocument()
  })
  it('inspects an unverified required skill', () => {
    setup()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Inspect claude-design: Load unverified',
      }),
    )
    expect(
      screen.getByText(/No matching read receipt was captured/),
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

  // ADR 0043: the receipt's See every event and the answer's own Full trace link did what the
  // heading's Full trace does, and Request a change only focused the box that is already there.
  // Field report (2026-10-04): a team with no required skill showed "0/0 required loaded" and
  // "Loading evidence and output quality are separate checks.", which told a newcomer nothing.
  it('counts required skills only when the team has some', () => {
    const designer = setup().props.agents[0]
    cleanup()
    setup({ agents: [{ ...designer, data: { ...designer.data, agent: { ...designer.data.agent, capabilities: [] } } }] })
    expect(screen.queryByText(/required loaded/)).not.toBeInTheDocument()
    expect(screen.queryByText(/separate checks/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /What was recorded/ })).toBeInTheDocument()
    cleanup()

    setup()
    expect(screen.getByText('0/1 required loaded')).toBeInTheDocument()
    expect(screen.getByText(/separate checks/)).toBeInTheDocument()
  })

  it('opens the full trace from one button, with no second way to the same place', () => {
    const { props } = setup()
    expect(screen.getAllByRole('button', { name: /Full trace|See every event/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Full trace' }))
    expect(props.onTrace).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Request a change' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Inspect handoff/ })).toBeNull()
  })
  it('supports filters without changing the team', () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(
      screen.getByText('No capabilities match this filter.'),
    ).toBeInTheDocument()
    expect(props.agents[0].data.agent.capabilities).toEqual([
      { kind: 'skill', name: 'claude-design' },
    ])
  })
  it('unwinds evidence before leaving the Run view', () => {
    setup()
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
  })
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
