// Regression (TNG-146, TNG-89A conformance): the provenance header's capture sentence must
// name every gap (TNG89_INTERACTION §5.2), never report a captured category as a gap, and
// "complete" may only appear where something was captured (§5.1). Built through the real
// `projectRun` so it cannot drift from what the projector actually emits.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../../lib/watch/events'
import { ProvenancePanel } from './ProvenancePanel'

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'lead'): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })

// The most ordinary LoomWatch run there is: one agent, a prompt, a plain-text answer.
// Nothing was captured for reasoning, skills, tools, commands or sources.
const plainAnswer: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 1 }),
  event(1, 'message', { role: 'user', content: { type: 'text', text: 'Summarise the ACP handshake.' } }),
  event(2, 'message', { role: 'agent', content: { type: 'text', text: 'The client sends initialize…' } }),
  event(3, 'turn_end', { stopReason: 'end_turn' }),
  event(4, 'process', { phase: 'exited', exitCode: 0 }),
]

// The counterfactual: a run that captured something in every one of the six categories.
const everything: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 1 }),
  event(1, 'message', { role: 'user', content: { type: 'text', text: 'Do the thing.' } }),
  event(2, 'thought', { role: 'thought', content: { type: 'text', text: 'Planning.' } }),
  event(3, 'tool_call', { callId: 'c1', title: 'Skill: design-md', name: 'skill_invoke', toolKind: 'other', status: 'in_progress' }),
  event(4, 'tool_update', { callId: 'c1', status: 'completed' }),
  event(5, 'tool_call', { callId: 'c2', title: '$ cargo test', name: 'terminal', toolKind: 'execute', status: 'in_progress' }),
  event(6, 'tool_update', { callId: 'c2', status: 'completed' }),
  event(7, 'tool_call', { callId: 'c3', title: 'Fetch the RFC', name: 'web_fetch', toolKind: 'fetch', status: 'in_progress' }),
  event(8, 'tool_update', { callId: 'c3', status: 'completed' }),
  event(9, 'tool_call', { callId: 'c4', title: 'Ask reviewer', name: 'ask', toolKind: 'other', status: 'in_progress' }),
  event(10, 'tool_update', { callId: 'c4', status: 'completed' }),
  event(11, 'tool_call', { callId: 'c5', title: 'Look up the weather', name: 'mcp__weather__lookup', toolKind: 'other', status: 'in_progress' }),
  event(12, 'tool_update', { callId: 'c5', status: 'completed' }),
  event(13, 'message', { role: 'agent', content: { type: 'text', text: 'Done.' } }),
  event(14, 'turn_end', { stopReason: 'end_turn' }),
  event(15, 'process', { phase: 'exited', exitCode: 0 }),
]

afterEach(cleanup)

describe('provenance capture sentence', () => {
  it('names every category that captured nothing', () => {
    const projection = projectRun(plainAnswer, Infinity, { responder: 'lead' })
    // Ground truth from the projector: five of the six categories are empty (CONTRACT §12
    // publishes a level and a reason per category, not a bare count).
    expect(projection.coverage).toMatchObject({
      agents: { level: 'complete' },
      reasoning: { level: 'unavailable' },
      skills: { level: 'unavailable' },
      tools: { level: 'unavailable' },
      commands: { level: 'unavailable' },
      sources: { level: 'unavailable' },
    })

    render(
      <ProvenancePanel
        projection={projection}
        ownerLabels={new Map([['lead', 'Lead · agent']])}
        onInspect={() => {}}
        onClose={() => {}}
      />,
    )

    const sentence = document.querySelector('.insp-status')?.textContent ?? ''
    for (const gap of ['reasoning', 'skills', 'tools', 'commands', 'sources']) {
      expect(sentence, `header must name the ${gap} gap`).toContain(gap)
    }
  })

  it('does not claim a category is complete when it captured nothing', () => {
    // A run record whose events have not arrived: the projector knows of no agents at all.
    const projection = projectRun([], Infinity, { responder: 'lead' })
    expect(projection.agents.length).toBe(0)
    expect(projection.coverage.agents).toMatchObject({ level: 'unavailable', observed: 0 })
    render(
      <ProvenancePanel projection={projection} ownerLabels={new Map()} onInspect={() => {}} onClose={() => {}} />,
    )
    const agentsZone = screen.getByText('agents').closest('.zone-head')
    expect(agentsZone?.textContent).not.toMatch(/complete/i)
    const agentsZoneBody = screen.getByText('agents').closest('.zone')
    expect(agentsZoneBody?.textContent).toContain('Not captured')
    expect(agentsZoneBody?.textContent).toContain('No agents were reported for this run.')
  })

  it('uses the spec word "Not captured" for an unavailable category', () => {
    const projection = projectRun(plainAnswer, Infinity, { responder: 'lead' })
    render(
      <ProvenancePanel
        projection={projection}
        ownerLabels={new Map([['lead', 'Lead · agent']])}
        onInspect={() => {}}
        onClose={() => {}}
      />,
    )
    const toolsZone = screen.getByText('tools').closest('.zone')
    expect(toolsZone?.textContent).toContain('Not captured')
    // §5.1: the reason, not a restatement of the count.
    expect(toolsZone?.textContent).toContain('No tool calls were recorded for this run.')
  })

  it('says "Complete capture" when every category captured something', () => {
    const projection = projectRun(everything, Infinity, { responder: 'lead' })
    // Ground truth: every one of the six categories captured at least one thing, every
    // spawned agent reached terminal evidence, and every call is paired.
    for (const [key, value] of Object.entries(projection.coverage)) {
      expect(value, `${key} should have captured something`).toMatchObject({ level: 'complete' })
      expect((value as { observed: number }).observed, `${key} should have an observed count`).toBeGreaterThan(0)
    }

    render(<ProvenancePanel projection={projection} ownerLabels={new Map([['lead', 'Lead · agent']])} onInspect={() => {}} onClose={() => {}} />)
    const status = document.querySelector('.insp-status')
    expect(status?.textContent).toContain('Complete capture')
    // §5.2: "complete" is scoped by the header tooltip, which scopes it to observed evidence.
    expect(status?.getAttribute('title')).toContain('Complete for what the adapters can observe')
  })

  it('never claims "Complete capture" while an agent is still running (TNG-162 B4)', () => {
    // The same six-category run, cut before the agent's turn ends and process exits.
    const projection = projectRun(everything.slice(0, 14), Infinity, { responder: 'lead' })
    expect(projection.coverage.agents).toMatchObject({ level: 'partial', reason: 'agents_awaiting_terminal_evidence' })

    render(<ProvenancePanel projection={projection} ownerLabels={new Map([['lead', 'Lead · agent']])} onInspect={() => {}} onClose={() => {}} />)
    const status = document.querySelector('.insp-status')
    expect(status?.textContent).not.toContain('Complete capture')
    expect(status?.textContent).toContain('Partial capture')
    expect(status?.textContent).toContain('agents partial')
  })

  it('reads partial for tools while a call sits unpaired (TNG-162 B5)', () => {
    // Cut at the last tool_call: c5 has been opened and never paired.
    const projection = projectRun(everything.slice(0, 12), Infinity, { responder: 'lead' })
    expect(projection.coverage.tools).toMatchObject({ level: 'partial', reason: 'unpaired_calls' })
    expect(projection.agents[0]).toMatchObject({ openCalls: 1 })

    render(<ProvenancePanel projection={projection} ownerLabels={new Map([['lead', 'Lead · agent']])} onInspect={() => {}} onClose={() => {}} />)
    const status = document.querySelector('.insp-status')
    expect(status?.textContent).not.toContain('Complete capture')
    expect(status?.textContent).toContain('tools partial')
  })
})
