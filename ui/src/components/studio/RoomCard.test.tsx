import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { figureFor } from '../../lib/library/figures'
import type { Room, RoomTeam } from '../../lib/projects/studio'
import { RoomCard, RoomWords } from './RoomCard'

afterEach(cleanup)

const team = (path: string, name: string, state: RoomTeam['state']): RoomTeam => ({
  path, name, state, schedule: null,
  seats: [{ kind: 'agent', id: `${path}-agent`, name: 'Ann', state: state === 'working' ? 'working' : 'ready', away: null }],
})
const room = (teams: RoomTeam[], line: string): Room => ({ id: 'shop', name: 'Shop website', putAway: false, teams, state: teams[0]?.state ?? 'ready', line, lastWorked: null })
const figureOf = () => figureFor('writer')

describe('a room card on Home (ADR 0097)', () => {
  it('names the team its desks are, and every other team at work, when the project has more than one', () => {
    const shop = room([team('gate.yaml', 'Research and design', 'waiting'), team('pages.yaml', 'Product pages', 'working'), team('weekly.yaml', 'Weekly report', 'ready')], 'Researcher is waiting for you')
    const { container } = render(<RoomCard room={shop} figureOf={figureOf} onOpen={() => {}} />)
    // Above the desks, before the agent at them.
    expect(container.querySelector('.room-card-floor')).toHaveTextContent(/^Research and designAnn/)
    expect(container.querySelector('.room-line')).toHaveTextContent('Researcher is waiting for you · Product pages is working · 1 other team ready')
    // The other team's name is plain; what it is doing is in its colour, and stays on one line with it.
    expect(screen.getByText('is working')).toHaveClass('room-state', 'working')
    expect(screen.getByText('is working').closest('.room-other')).toHaveTextContent(/^Product pages is working$/)
  })

  it('counts the quiet teams as more when every team is quiet, and the list, which names them all, leaves the count out', () => {
    const quiet = room([team('a.yaml', 'Alpha', 'ready'), team('b.yaml', 'Beta', 'ready'), team('c.yaml', 'Gamma', 'ready')], 'Ready')
    expect(render(<p><RoomWords room={quiet} /></p>).container).toHaveTextContent(/^Ready · 2 more teams$/)
    cleanup()
    const busy = room([team('a.yaml', 'Alpha', 'waiting'), team('b.yaml', 'Beta', 'failed'), team('c.yaml', 'Gamma', 'ready')], 'Ann is waiting for you')
    expect(render(<p><RoomWords room={busy} count={false} /></p>).container).toHaveTextContent(/^Ann is waiting for you · Beta didn’t finish$/)
  })

  it('names two other teams at work at most, and counts the rest', () => {
    const busy = room([team('a.yaml', 'Alpha', 'waiting'), ...['Beta', 'Gamma', 'Delta', 'Epsilon'].map((name) => team(`${name}.yaml`, name, 'working')), team('z.yaml', 'Zeta', 'ready')], 'Ann is waiting for you')
    expect(render(<p><RoomWords room={busy} /></p>).container).toHaveTextContent(/^Ann is waiting for you · Beta is working · Gamma is working · 3 more teams$/)
  })

  it('leaves a project with one team as it was: its desks and its line, no team name', () => {
    const { container } = render(<RoomCard room={room([team('blog.yaml', 'Blog', 'ready')], 'Ready')} figureOf={figureOf} onOpen={() => {}} />)
    expect(container.querySelector('.room-card-team')).toBeNull()
    expect(container.querySelector('.room-line')).toHaveTextContent(/^Ready$/)
  })
})
