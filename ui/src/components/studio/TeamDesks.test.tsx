import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

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
    { kind: 'agent', id: 'researcher', name: 'Researcher', agent: 'researcher', state: 'ready', away: 'in Website' },
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
    expect(desk('Researcher')).toHaveTextContent('in Website')
    // At its desk, an agent glows with its state.
    expect(desk('Designer').querySelector('[data-glow="ready"]')?.querySelector('img')).toHaveAttribute('src', figureStill(figureFor('designer')))

    // Where you check: the review step's own mark, its ring and dot.
    expect(desk('You check').querySelectorAll('svg.agent-mark.you .mk-ring, svg.agent-mark.you .mk-dot')).toHaveLength(2)
    // No stand-in shapes: no dashed person, no bare circle.
    expect(container.querySelector('.desk-outline')).toBeNull()
  })

  it('lights an agent waiting for you gold at its own desk, saying so, and leaves every press to what holds the desks', () => {
    const waiting: RoomTeam = { ...team, seats: [{ kind: 'agent', id: 'writer', name: 'Writer', agent: 'writer', state: 'waiting', away: null }] }
    render(<TeamDesks team={waiting} figureOf={(seat) => figureFor(seat.agent ?? seat.id)} />)
    expect(screen.getByText('Writer').closest('.desk')?.querySelector('[data-glow="waiting"]')).not.toBeNull()
    expect(screen.getByText('waiting for you')).toHaveClass('desk-state', 'waiting')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('draws the figures alone in a line of words, each named to a screen reader by the row', () => {
    render(<TeamDesks team={team} figureOf={(seat) => figureFor(seat.agent ?? seat.id)} compact />)
    expect(screen.queryByText('Designer')).toBeNull()
    expect(screen.getByRole('group', { name: 'Research and design: Researcher is in Website, then You check, then Designer' })).toBeInTheDocument()
  })
})
