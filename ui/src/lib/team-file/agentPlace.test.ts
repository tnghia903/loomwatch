import { describe, expect, it } from 'vitest'

import { agentPlace, type AgentPlaceInput } from './agentPlace'
import { pipelineOrder } from './pipelineOrder'

const nodes = [
  { id: 'research', name: 'Researcher' },
  { id: 'check', name: 'Fact-checker' },
  { id: 'review', name: 'You', kind: 'operator' as const },
  { id: 'write', name: 'Writer' },
]

function pipeline(agentId: string, edges: AgentPlaceInput['edges'], responder = 'write'): ReturnType<typeof agentPlace> {
  const steps = pipelineOrder(nodes.map((node) => node.id), edges, 'research')
  return agentPlace({ agentId, nodes, edges, steps, entrypoint: 'research', responder, pipeline: true })
}

const chain = [
  { from: 'research', to: 'check' },
  { from: 'check', to: 'review' },
  { from: 'review', to: 'write' },
]

describe('agentPlace', () => {
  it('names the step, its neighbours, and a review stop as yours', () => {
    expect(pipeline('check', chain)).toEqual({
      summary: 'Step 2 of 4 · after Researcher · hands its work to your review.',
      final: false,
      canStart: false,
    })
  })

  it('says the first step receives the request and the responder writes the output', () => {
    expect(pipeline('research', chain).summary).toBe('Step 1 of 4 · receives your request first · hands its work to Fact-checker.')
    expect(pipeline('write', chain)).toMatchObject({ summary: 'Step 4 of 4 · after your review. Its answer is the team’s output.', final: true })
  })

  it('names both branches at a join', () => {
    const join = [{ from: 'research', to: 'check' }, { from: 'research', to: 'write' }, { from: 'check', to: 'write' }]
    expect(pipeline('write', join).summary).toContain('after Researcher and Fact-checker')
  })

  // pipeline_order() refuses an entrypoint with an incoming edge, so only a source may start.
  it('offers the start only to an agent nothing hands work to', () => {
    expect(pipeline('check', chain).canStart).toBe(false)
    const loose = pipeline('write', [{ from: 'research', to: 'check' }])
    expect(loose).toMatchObject({ summary: 'Not one of the steps yet. Connect it to put it in the order.', canStart: true })
  })

  it('describes team mode as a lead and the helpers it hands work to', () => {
    const team = (agentId: string) => agentPlace({ agentId, nodes: nodes.filter((node) => node.kind !== 'operator'), edges: [], steps: [], entrypoint: 'research', responder: 'research', pipeline: false })
    expect(team('research')).toEqual({ summary: 'Leads the team: it receives your request first, and its answer is the team’s output.', final: true, canStart: false })
    expect(team('check')).toEqual({ summary: 'Helps when Researcher hands it part of the work.', final: false, canStart: true })
  })

  it('has nothing to arrange for a team of one', () => {
    const solo = agentPlace({ agentId: 'research', nodes: [nodes[0]], edges: [], steps: [], entrypoint: 'research', responder: 'research', pipeline: false })
    expect(solo).toEqual({ summary: 'The only agent: it receives your request and writes the answer.', final: true, canStart: false })
  })
})
