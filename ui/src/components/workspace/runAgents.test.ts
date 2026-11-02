import { describe, expect, it } from 'vitest'

import { runAgentNodes } from './runAgents'

type Input = Parameters<typeof runAgentNodes>[0]

const input = (guestNames?: ReadonlyMap<string, string>): Input => ({
  doc: { nodes: [], edges: [], mode: 'team', entrypoint: 'lead' },
  session: { mode: 'live', cursor: null },
  projection: { agents: [], delegations: [], messages: [] } as unknown as Input['projection'],
  record: null,
  phase: 'succeeded',
  orderedAgentIds: ['mine+researcher', 'lead~2', 'loomwatch:check'],
  evidenceByAgent: new Map(),
  leadId: 'lead',
  waiting: null,
  packetAgentIds: new Set(),
  synthMeasurements: {},
  capabilityCards: [],
  allWiringEdges: [],
  helperPlacements: { 'mine+researcher': { x: 0, y: 0 }, 'lead~2': { x: 0, y: 100 }, 'loomwatch:check': { x: 0, y: 200 } },
  historicalPositions: null,
  ...(guestNames ? { guestNames } : {}),
})

describe('a run’s agents the team file doesn’t list', () => {
  // ADR 0092: one of the person's other agents a run brought in is named as in My agents.
  it('names one brought in from My agents by its name there, and by its id when that isn’t known', () => {
    const named = runAgentNodes(input(new Map([['mine+researcher', 'Researcher']])))
    expect(named.map((node) => node.data.agent.name)).toEqual(['Researcher', 'lead’s helper 2', 'LoomWatch'])
    expect(runAgentNodes(input()).map((node) => node.data.agent.name)).toEqual(['mine+researcher', 'lead’s helper 2', 'LoomWatch'])
  })

  // Run 03f7b0dd: the receipt read "loomwatch:check stopped" and the timeline "loomwatch:ch…". The
  // run's Details are named from these, so they name LoomWatch's check, and a helper, as the chat does.
  it('names LoomWatch’s own check LoomWatch, and a helper after the agent it helps', () => {
    const lead = { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Ada', agent: { id: 'lead', name: 'Ada', role: '', spawn: { cmd: '', args: [], env: {}, cwd: '.' }, model: '' } } }
    const named = runAgentNodes({ ...input(), doc: { ...input().doc, nodes: [lead] as unknown as Input['doc']['nodes'] }, orderedAgentIds: ['lead', 'lead~2', 'loomwatch:check'] })
    expect(named.map((node) => node.data.agent.name)).toEqual(['Ada', 'Ada’s helper 2', 'LoomWatch'])
  })
})
