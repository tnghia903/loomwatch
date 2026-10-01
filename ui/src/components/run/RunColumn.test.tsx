// Regression (TNG-173, TNG89_INTERACTION §11.6): below 768 px the coordinate canvas is
// replaced by this column, so anything the canvas alone carried is simply gone. Three
// §11.6 stages had no counterpart here — coverage, filters, summaries — which left §4.1's
// summaries, §4.4's filters and every visible trace of the §5 honesty layer unreachable at
// phone width. The static gate (docs/mockups/verify-narrow-conformance.mjs) can only see
// that the shapes exist; these assert that they work.
//
// Built through the real `projectRun` so the coverage sentence cannot drift from what the
// projector actually emits.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { OutputNode } from '../../lib/runs/graph'
import { projectRun, type RunEvent } from '../../lib/watch/events'
import { CanvasActionsContext, type CanvasActions } from '../canvas/CanvasActionsContext'
import { RunColumn } from './RunColumn'

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'lead'): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })

// A run that captured a command and a fetched source, and nothing else: the ordinary case
// where the honesty layer has something real to admit.
const mixedRun: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 1 }),
  event(1, 'message', { role: 'user', content: { type: 'text', text: 'Check the build.' } }),
  event(2, 'tool_call', { callId: 'c1', title: '$ cargo test', name: 'terminal', toolKind: 'execute', status: 'in_progress' }),
  event(3, 'tool_update', { callId: 'c1', status: 'completed' }),
  event(4, 'tool_call', { callId: 'c2', title: 'Fetch the RFC', name: 'web_fetch', toolKind: 'fetch', status: 'in_progress' }),
  event(5, 'tool_update', { callId: 'c2', status: 'completed' }),
  event(6, 'message', { role: 'agent', content: { type: 'text', text: 'The build is green.' } }),
  event(7, 'turn_end', { stopReason: 'end_turn' }),
  event(8, 'process', { phase: 'exited', exitCode: 0 }),
]

const output: OutputNode['data'] = {
  text: 'The build is green.', phase: 'succeeded', phaseText: 'Answered.', producer: 'lead', producerLabel: 'Agent A · lead',
  mode: 'live', streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: true,
}

const leadNode = {
  id: 'lead', type: 'agent', position: { x: 0, y: 0 },
  data: { agent: { name: 'Agent A', role: 'lead' }, isEntrypoint: true, runtime: { status: 'succeeded', ownerLabel: 'Agent A · lead', taskState: 'DONE', task: 'Check the build' } },
} as unknown as AgentNode

function renderColumn(actions: Partial<CanvasActions> = {}) {
  const projection = projectRun(mixedRun, Infinity, { responder: 'lead' })
  const context: CanvasActions = {
    renameAgent: vi.fn(), touchField: vi.fn(), mode: 'team', stepById: new Map(), nodeNames: new Map(),
    toggleProvenance: vi.fn(), reusePrompt: vi.fn(), inspectEvidence: vi.fn(), ...actions,
  }
  const result = render(
    <CanvasActionsContext.Provider value={context}>
      <RunColumn
        prompt="Check the build." attempt={1} phase={projection.phase} branch="Initiating branch" elapsed="8s" mode="live"
        agents={[leadNode]}
        evidenceByAgent={new Map([['lead', projection.evidence]])}
        ownerLabels={new Map([['lead', 'Agent A · lead']])}
        output={output}
        projection={projection}
        selectedEvidenceId={null}
        onInspectEvidence={vi.fn()}
        onSelectAgent={vi.fn()}
      />
    </CanvasActionsContext.Provider>,
  )
  return { ...result, projection, context }
}

afterEach(cleanup)

describe('RunColumn provenance stages (§11.6)', () => {
  it('states the run coverage on its own face, matching the projector', () => {
    const { projection } = renderColumn()
    // Ground truth: commands and sources captured, the other four did not.
    expect(projection.coverage).toMatchObject({
      commands: { level: 'complete' },
      sources: { level: 'complete' },
      reasoning: { level: 'unavailable' },
      skills: { level: 'unavailable' },
    })
    // §5.2: the gaps are named in full, no truncation, and "Complete capture" is not claimed.
    const sentence = screen.getByTitle(/never an agent's private internal state/)
    expect(sentence.textContent).toContain('Partial capture')
    expect(sentence.textContent).toContain('reasoning, skills and tools')
    expect(sentence.textContent).not.toContain('Complete capture')
  })

  it('keeps §11.6 source order — the provenance stages follow the response', () => {
    const { container } = renderColumn()
    const order = [...container.querySelectorAll('.story-output, .run-prov-cov, .run-prov-filters, .run-prov-sums')]
      .map((element) => element.className.split(' ').find((name) => name.startsWith('story-') || name.startsWith('run-prov')))
    expect(order).toEqual(['story-output', 'run-prov-cov', 'run-prov-filters', 'run-prov-sums'])
  })

  it('opens the full provenance panel from a control reachable in the column (failure 22)', () => {
    const toggleProvenance = vi.fn()
    renderColumn({ toggleProvenance })
    fireEvent.click(screen.getByRole('button', { name: 'Open full provenance' }))
    expect(toggleProvenance).toHaveBeenCalledTimes(1)
    // …and from a summary, which is the way in §4.1 actually describes.
    fireEvent.click(screen.getByRole('button', { name: /^commands, 1 entity, complete/ }))
    expect(toggleProvenance).toHaveBeenCalledTimes(2)
  })

  it('states capture quality on the card face, not only in the accessible name (§5.1)', () => {
    const { container } = renderColumn()
    const card = container.querySelector('.activity-ent')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByText('Recorded')).toBeInTheDocument()
  })

  it('filters the evidence the run shows, as view state only (§4.4/§6.7)', () => {
    const { container } = renderColumn()
    expect(container.querySelectorAll('.activity-ent')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'commands' }))
    const names = [...container.querySelectorAll('.activity-ent .ae-name')].map((element) => element.textContent)
    expect(names).toEqual(['Fetch the RFC'])
    // The summary still reports what the projector observed — a filtered view must never
    // be able to look like a capture gap.
    expect(screen.getByRole('button', { name: /^commands, 1 entity, complete/ })).toBeInTheDocument()
  })

  it('says an emptied list is a filter, not an empty run (§5.1)', () => {
    renderColumn()
    fireEvent.click(screen.getByRole('button', { name: 'Only redacted' }))
    expect(screen.getByText(/No evidence matches these filters/)).toBeInTheDocument()
    expect(screen.getByText(/2 entities were captured for this run/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.queryByText(/No evidence matches these filters/)).not.toBeInTheDocument()
  })
})
