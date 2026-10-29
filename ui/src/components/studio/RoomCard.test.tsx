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
  it('lists each team on a line, most pressing first, saying what it is doing in words as well as colour', () => {
    const scheduled = { ...team('weekly.yaml', 'Weekly report', 'ready'), schedule: 'Every Monday at 9:00' }
    const shop = room([team('gate.yaml', 'Research and design', 'waiting'), team('pages.yaml', 'Product pages', 'working'), team('fix.yaml', 'Fixes', 'failed'), scheduled], 'Researcher is waiting for you')
    render(<RoomCard room={shop} figureOf={figureOf} onOpen={() => {}} />)
    const lines = screen.getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual([
      'Research and designwaiting for you',
      'Product pagesAnn is working',
      'FixesDidn’t finish',
      'Weekly reportRuns every Monday at 9:00',
    ])
    expect(screen.getByText('Ann is working')).toHaveClass('room-state', 'working')
    // The whole line opens the team's chat.
    expect(screen.getByText('Product pages').closest('a')).toHaveAttribute('href', '/?path=pages.yaml&view=chat')
    expect(screen.getByText('Ann is working').closest('a')).toBe(screen.getByText('Product pages').closest('a'))
    // Each team's agents stand on its line, named for a screen reader.
    expect(screen.getByRole('group', { name: 'Product pages: Ann is working' })).toBeInTheDocument()
    expect(screen.getByText('4 teams')).toBeInTheDocument()
  })

  it('lists four teams at most, and counts the rest; with the newest thing made here and this month’s cost', () => {
    const many = room(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => team(`${name}.yaml`, name, 'ready')), 'Ready')
    render(<RoomCard room={many} figureOf={figureOf} onOpen={() => {}} newest="/teams/post.md" spend="$1.20 this month" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('2 more teams')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /post\.md/ })).toBeInTheDocument()
    expect(screen.getByText('$1.20 this month')).toBeInTheDocument()
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

  it('says nothing about a count, a file or a cost it doesn’t have', () => {
    render(<RoomCard room={room([team('blog.yaml', 'Blog', 'ready')], 'Ready')} figureOf={figureOf} onOpen={() => {}} />)
    expect(screen.getByRole('listitem')).toHaveTextContent(/^BlogReady$/)
    expect(screen.queryByText(/teams$/)).toBeNull()
    expect(screen.queryByText(/this month/)).toBeNull()
  })
})
