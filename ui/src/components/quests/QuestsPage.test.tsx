import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { partsDone, type Wardrobe } from '../../lib/quests/wardrobe'
import { QuestsPage } from './QuestsPage'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const earned: Wardrobe = {
  monocle: { at: '2026-10-15T10:00:00Z', runId: 'run-1', teamPath: 'digest.yaml' },
  scissors: { at: '2026-10-15T11:00:00Z', runId: 'run-2' },
}

const card = (name: string) => screen.getByText(name, { selector: '.quest-name b' }).closest('li') as HTMLElement

describe('the Quests page', () => {
  it('lists every set of clothes, accessory and figure, and how many are earned', () => {
    render(<QuestsPage wardrobe={earned} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Quests' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Your progress' })).toHaveTextContent('2 of 13 earned')
    expect(within(screen.getByRole('region', { name: /Clothes/ })).getAllByRole('listitem')).toHaveLength(4)
    expect(within(screen.getByRole('region', { name: /Accessories/ })).getAllByRole('listitem')).toHaveLength(7)
    expect(within(screen.getByRole('region', { name: /Figures/ })).getAllByRole('listitem').filter((item) => item.classList.contains('quest-card'))).toHaveLength(2)
  })

  it('says what to try and how a locked one is earned, and why an earned one works', () => {
    render(<QuestsPage wardrobe={earned} />)
    const tape = card('Tailor’s tape')
    expect(tape).toHaveTextContent('Not yet')
    expect(tape).toHaveTextContent('Give an agent only the folders its job needs, not a whole drive.')
    expect(tape).toHaveTextContent('Earned when')
    const monocle = card('Button monocle')
    expect(monocle).toHaveClass('earned')
    expect(monocle).toHaveTextContent('A second look against clear criteria catches what the first pass missed')
    expect(monocle).not.toHaveTextContent('Earned when')
  })

  it('links to the run that earned an item when it knows the team', () => {
    render(<QuestsPage wardrobe={earned} />)
    expect(within(card('Button monocle')).getByRole('link', { name: /See the run that earned it/ })).toHaveAttribute('href', '/?path=digest.yaml&run=run-1')
    expect(within(card('Scissors')).queryByRole('link')).toBeNull()
  })

  it('shows which of the five parts Bobbin still needs', () => {
    expect([...partsDone(earned)].sort()).toEqual(['graph', 'loop'])
    render(<QuestsPage wardrobe={earned} />)
    const parts = within(card('Bobbin')).getByRole('list', { name: '2 of 5 parts so far' })
    expect(within(parts).getByText('Team shape').closest('li')).toHaveClass('on')
    expect(within(parts).getByText('Prompt').closest('li')).not.toHaveClass('on')
  })
})
