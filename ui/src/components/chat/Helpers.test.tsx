import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HelperWork } from '../../lib/chat/helpers'
import { figureStill } from '../../lib/library/figures'
import { TeamFiguresContext } from '../agents/figureContext'
import { Helpers } from './Helpers'

afterEach(cleanup)

const figures = new Map([['ada', { kind: 'yarn' as const, color: 'sage' as const }]])
const names = new Map([['ada', 'Ada']])
const name = (id: string) => names.get(id) ?? `Ada’s helper ${id.split('~')[1]}`

const helper = (number: number, state: HelperWork['state'], more: Partial<HelperWork> = {}): HelperWork => ({
  id: `ada~${number}`, messageId: `ada:call-${number}`, lead: 'ada', number, title: `Part ${number}`, brief: `Do part ${number}.`,
  state, reply: state === 'done' ? `Part ${number} found.` : null, error: state === 'failed' ? 'the provider is down' : null,
  startedAt: '2026-10-20T09:00:00Z', finishedAt: state === 'working' ? null : '2026-10-20T09:01:05Z', steps: 3, now: state === 'working' ? 'Web search: rent' : null,
  ...more,
})

const show = (helpers: HelperWork[], live: boolean, more: { onShow?: (id: string) => void; onStop?: (id: string) => Promise<void> } = {}) => render(
  <TeamFiguresContext.Provider value={figures}>
    <Helpers helpers={helpers} live={live} lead="Ada" name={name} hue={() => 3} {...more} />
  </TeamFiguresContext.Provider>,
)

describe('an agent’s helpers on its piece of work (ADR 0079)', () => {
  it('shows each one as the agent’s own figure, counted on one line, and open while they work', () => {
    const { container } = show([helper(1, 'done'), helper(2, 'working'), helper(3, 'working')], true)
    expect(screen.getByRole('region', { name: 'Ada’s helpers' })).toBeInTheDocument()
    const head = screen.getByRole('button', { name: /3 helpers · 2 working/ })
    expect(head).toHaveAttribute('aria-expanded', 'true')
    const faces = container.querySelectorAll('.tc-helpers-faces .chat-avatar')
    expect(faces).toHaveLength(3)
    for (const face of faces) {
      expect(face).toHaveClass('has-figure')
      expect(face.querySelector('img')).toHaveAttribute('src', figureStill({ kind: 'yarn', color: 'sage' }))
    }
    // The fan in the gutter is as wide as it allows; each part's row wears its number.
    expect((container.querySelector('.tc-helpers-faces') as HTMLElement).style.getPropertyValue('--count')).toBe('3')
    expect([...container.querySelectorAll('.tc-helper-row .tc-helper-number')].map((badge) => badge.textContent)).toEqual(['1', '2', '3'])
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    // What a helper at work is doing now, under its part.
    expect(screen.getAllByText('Web search: rent')).toHaveLength(2)
  })

  it('opens the talk at what its agent asked a helper, and stops one at work', async () => {
    const onShow = vi.fn()
    const onStop = vi.fn(() => Promise.resolve())
    show([helper(1, 'done'), helper(2, 'working'), helper(3, 'failed')], true, { onShow, onStop })
    fireEvent.click(screen.getByRole('button', { name: /Ada’s helper 1: Part 1, done, 3 steps\. Show what Ada asked it/ }))
    expect(onShow).toHaveBeenCalledWith('ada:call-1')
    expect(screen.getByRole('button', { name: /Ada’s helper 3: Part 3, couldn’t finish/ })).toBeInTheDocument()
    // Only a helper at work can be stopped.
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Ada’s helper 2' }))
    expect(onStop).toHaveBeenCalledWith('ada~2')
    expect(screen.getByRole('button', { name: 'Stop Ada’s helper 2' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /3 helpers · 1 working/ })).toBeInTheDocument()
  })

  it('folds to its one line once the piece is done, with nothing left to stop, and opens on a click', () => {
    show([helper(1, 'done'), helper(2, 'done')], false, { onStop: () => Promise.resolve() })
    const head = screen.getByRole('button', { name: /2 helpers · done/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()
    fireEvent.click(head)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByText('1m 05s')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()
  })

  it('offers no Stop once the piece is over, even for a helper the record left working', () => {
    show([helper(1, 'working')], false, { onStop: () => Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: /1 helper · 1 working/ }))
    expect(screen.getByText('Web search: rent')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()
  })

  it('shows the Markdown in a part’s title, with no link in its row, and names the row in words', async () => {
    const onShow = vi.fn()
    const { container } = show([helper(1, 'done', { title: 'Check **rent** in `prices.csv` against [the list](https://example.com)' })], true, { onShow })
    expect(await screen.findByText('rent', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('prices.csv', { selector: 'code' })).toBeInTheDocument()
    const row = screen.getByRole('button', { name: /^Ada’s helper 1: Check rent in prices\.csv against the list, done/ })
    expect(row.querySelector('a')).toBeNull()
    expect(container.querySelector('.tc-helper-title')).toHaveTextContent('Check rent in prices.csv against the list')
  })

  it('is nothing when the agent brought in no helpers', () => {
    const { container } = show([], true)
    expect(container).toBeEmptyDOMElement()
  })
})
