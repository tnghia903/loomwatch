import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { CheckupFinding } from '../../lib/team-file/checkup'
import { TEAM_MOVED } from '../../lib/team-file/teamMoved'
import { useTeamCheckup } from './useTeamCheckup'

const FINDING: CheckupFinding = {
  id: 'needs-web:writer', rule: 'needs-web', severity: 'improve',
  agentId: 'writer', agentIds: ['writer'], title: 'Writer can’t search the web', why: 'Its instructions ask for sources.',
}

vi.mock('../../lib/ai/useKeyStatus', () => ({ useAiStatus: () => null }))
vi.mock('../../lib/ai/useModels', () => ({ useModels: () => ({ catalog: [] }) }))
vi.mock('../../lib/ai/efforts', () => ({ modelEfforts: () => [] }))
vi.mock('../../lib/team-file/checkup', async (original) => ({ ...await original<typeof import('../../lib/team-file/checkup')>(), checkup: () => [FINDING] }))

afterEach(() => { window.localStorage.clear() })

type Doc = Parameters<typeof useTeamCheckup>[0]

function team(path: string): Doc {
  return { path, nodes: [], edges: [], entrypoint: 'writer', teamSchedule: null } as unknown as Doc
}

// ADR 0099: Rename moves the team's file, and what was hidden for the team is kept by its path.
it('keeps a suggestion hidden after the team’s file moves', () => {
  const { result, rerender } = renderHook(({ doc }) => useTeamCheckup(doc, null, () => {}), { initialProps: { doc: team('/teams/trip.yaml') } })
  act(() => result.current.dismiss(FINDING))
  expect(result.current.findings).toEqual([])

  act(() => { window.dispatchEvent(new CustomEvent(TEAM_MOVED, { detail: { from: '/teams/trip.yaml', to: '/teams/kyoto-week.yaml' } })) })
  rerender({ doc: team('/teams/kyoto-week.yaml') })
  expect(result.current.findings).toEqual([])
  expect(result.current.hiddenCount).toBe(1)
  expect(JSON.parse(window.localStorage.getItem('loomwatch.checkup.hidden') ?? '{}')).toEqual({ '/teams/kyoto-week.yaml': ['needs-web:writer'] })
})
