import { describe, expect, it } from 'vitest'

import { runAgentNodes } from './runAgents'

type Input = Parameters<typeof runAgentNodes>[0]

const input = (guestNames?: ReadonlyMap<string, string>): Input => ({
  doc: { nodes: [], edges: [], mode: 'team', entrypoint: 'lead' },
  session: { mode: 'live', cursor: null },
  projection: { agents: [], delegations: [], messages: [] } as unknown as Input['projection'],
  record: null,
  phase: 'succeeded',
  orderedAgentIds: ['mine+researcher', 'lead~2'],
  evidenceByAgent: new Map(),
  leadId: 'lead',
  waiting: null,
  packetAgentIds: new Set(),
  synthMeasurements: {},
  capabilityCards: [],
  allWiringEdges: [],
  helperPlacements: { 'mine+researcher': { x: 0, y: 0 }, 'lead~2': { x: 0, y: 100 } },
  historicalPositions: null,
  ...(guestNames ? { guestNames } : {}),
})

describe('a run’s agents the team file doesn’t list', () => {
  // ADR 0092: one of the person's other agents a run brought in is named as in My agents.
  it('names one brought in from My agents by its name there, and anyone else by id', () => {
    const named = runAgentNodes(input(new Map([['mine+researcher', 'Researcher']])))
    expect(named.map((node) => node.data.agent.name)).toEqual(['Researcher', 'lead~2'])
    expect(runAgentNodes(input()).map((node) => node.data.agent.name)).toEqual(['mine+researcher', 'lead~2'])
  })
})
