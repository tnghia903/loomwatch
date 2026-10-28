import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { figureFor, figureStill } from '../../lib/library/figures'
import type { RoomTeam } from '../../lib/projects/studio'
import { TeamDesks } from './TeamDesks'

afterEach(cleanup)

const team: RoomTeam = {
  path: 'gate.yaml',
  name: 'Research and design',
  state: 'waiting',
  schedule: null,
  seats: [
    { kind: 'agent', id: 'researcher', name: 'Researcher', agent: 'researcher', state: 'waiting', away: 'at your desk' },
    { kind: 'you', id: 'review', name: 'You', state: 'ready', away: null },
    { kind: 'agent', id: 'designer', name: 'Designer', agent: 'designer', state: 'ready', away: null },
  ],
}

describe('a team’s desks (ADR 0097)', () => {
  it('draws an agent somewhere else as itself, faint and unlit, and your seat as the ring you wear on the canvas', () => {
    const { container } = render(<TeamDesks team={team} figureOf={(seat) => figureFor(seat.agent ?? seat.id)} />)
    const desk = (name: string) => screen.getByText(name).closest('.desk') as HTMLElement

    // Away, the Researcher is still its own figure, with no state light: the words say where it is.
    const away = desk('Researcher').querySelector('img')
    expect(away).toHaveAttribute('src', figureStill(figureFor('researcher')))
    expect(away?.closest('[data-glow]')).toBeNull()
    expect(desk('Researcher')).toHaveTextContent('at your desk')
    // At its desk, an agent glows with its state.
    expect(desk('Designer').querySelector('[data-glow="ready"]')?.querySelector('img')).toHaveAttribute('src', figureStill(figureFor('designer')))

    // Where you check: the review step's own mark, its ring and dot.
    expect(desk('You check').querySelectorAll('svg.agent-mark.you .mk-ring, svg.agent-mark.you .mk-dot')).toHaveLength(2)
    // No stand-in shapes: no dashed person, no bare circle.
    expect(container.querySelector('.desk-outline')).toBeNull()
  })

  it('lets you press only an agent at your desk, to go to it; one in another team leaves the click to its room', () => {
    const elsewhere: RoomTeam = { ...team, seats: [...team.seats, { kind: 'agent', id: 'writer', name: 'Writer', agent: 'writer', state: 'ready', away: 'in Website' }] }
    const onAway = vi.fn()
    render(<TeamDesks team={elsewhere} figureOf={(seat) => figureFor(seat.agent ?? seat.id)} onAway={onAway} />)
    fireEvent.click(screen.getByRole('button', { name: /Researcher/ }))
    expect(onAway).toHaveBeenCalledWith(expect.objectContaining({ id: 'researcher' }))
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('in Website')).toBeInTheDocument()
  })
})
