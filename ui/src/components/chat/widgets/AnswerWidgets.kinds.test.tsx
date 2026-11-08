import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dateWritten } from '../../../lib/widgets/timeline'
import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'

afterEach(() => { cleanup(); vi.useRealTimers() })

/** The daemon, keeping what it is sent: what `onChange` answers. */
function keeper(spec: KeptWidget['spec']) {
  const kept: { n: number; state: WidgetState }[] = []
  const onChange = vi.fn(async (n: number, state: WidgetState) => {
    kept.push({ n, state })
    return { n, spec, state, changedAt: `2026-11-08T10:00:0${kept.length}.000Z` }
  })
  return { kept, onChange }
}

const visa: KeptWidget = {
  n: 1,
  spec: {
    kind: 'finder',
    title: 'Do you need a visa for Japan?',
    questions: [
      { text: 'Which passport do you hold?', answers: [{ label: 'US, UK or EU', outcome: 1 }, { label: 'Vietnam', next: 2 }] },
      { text: 'How long will you stay?', answers: [{ label: 'Up to 15 days', outcome: 2 }, { label: 'Longer', outcome: 3 }] },
    ],
    outcomes: [
      { label: 'No visa needed', text: 'Stay up to 90 days on your passport.' },
      { label: 'An e-visa', text: 'Apply online at least a week before you fly.' },
      { label: 'A visa from the embassy' },
    ],
  },
}

const quiz: KeptWidget = {
  n: 2,
  spec: {
    kind: 'quiz',
    title: 'Check yourself',
    checks: [
      { question: 'Where does the oxygen come from?', choices: ['Carbon dioxide', 'Water', 'The soil'], answer: 1, why: 'Light splits water in the leaf.' },
      { question: 'What does the plant make?', choices: ['Sugar', 'Salt'], answer: 0 },
    ],
  },
}

const fever: KeptWidget = {
  n: 3,
  spec: {
    kind: 'scale',
    title: 'Is 38.5 °C a fever?',
    unit: '°C',
    decimals: 1,
    ranges: [{ label: 'Low', from: 35, to: 36.1 }, { label: 'Normal', from: 36.1, to: 37.5 }, { label: 'Fever', from: 37.5, to: 40 }],
    pins: [{ label: 'You', value: 38.5 }],
  },
}

const books: KeptWidget = {
  n: 4,
  spec: {
    kind: 'timeline',
    title: 'The Harry Potter books',
    events: [
      { date: '1997-06-26', label: 'Philosopher’s Stone', note: 'In the UK' },
      { date: '1998', label: 'Chamber of Secrets' },
      { date: '2007', label: 'Deathly Hallows' },
    ],
  },
}

describe('AnswerWidgets, a finder', () => {
  it('asks one question at a time, leads to the outcome for your case, and keeps your path', async () => {
    const { kept, onChange } = keeper(visa.spec)
    render(<AnswerWidgets widgets={[visa]} onChange={onChange} />)
    const finder = screen.getByRole('region', { name: 'Do you need a visa for Japan?' })
    expect(within(finder).getByRole('group', { name: 'Which passport do you hold?' })).toBeInTheDocument()
    expect(finder).not.toHaveTextContent('An e-visa')
    fireEvent.click(within(finder).getByRole('button', { name: 'Vietnam' }))
    // The next question its answer leads to, with what you answered above it.
    expect(within(finder).getByRole('group', { name: 'How long will you stay?' })).toBeInTheDocument()
    expect(within(finder).getByRole('button', { name: /Which passport do you hold\? Vietnam/ })).toBeInTheDocument()
    await waitFor(() => expect(kept).toEqual([{ n: 1, state: { answers: [1] } }]))
    // The button you tapped is gone: focus moves on to the next question's first answer.
    expect(document.activeElement).toBe(within(finder).getByRole('button', { name: 'Up to 15 days' }))
    fireEvent.click(within(finder).getByRole('button', { name: 'Up to 15 days' }))
    expect(finder).toHaveTextContent('An e-visa')
    expect(document.activeElement).toHaveTextContent('An e-visa')
    expect(finder).toHaveTextContent('Apply online at least a week before you fly.')
    expect(within(finder).queryByRole('group', { name: 'How long will you stay?' })).toBeNull()
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 1, state: { answers: [1, 0] } }))
    expect(finder).toHaveTextContent('Tap an answer to change it.')
    // Tapping an answer you gave asks that question again, keeping the answers before it.
    fireEvent.click(within(finder).getByRole('button', { name: /How long will you stay\? Up to 15 days/ }))
    expect(within(finder).getByRole('group', { name: 'How long will you stay?' })).toBeInTheDocument()
    expect(within(finder).getByRole('button', { name: /Which passport do you hold\? Vietnam/ })).toBeInTheDocument()
    expect(finder).not.toHaveTextContent('An e-visa')
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 1, state: { answers: [1] } }))
    // The answer you gave is marked, and tapping it again brings back the rest of your path.
    expect(within(finder).getByRole('button', { name: 'Up to 15 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(finder).getByRole('button', { name: 'Longer' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(finder).getByRole('button', { name: 'Up to 15 days' }))
    expect(finder).toHaveTextContent('An e-visa')
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 1, state: { answers: [1, 0] } }))
    // From the first row, back to the first question; another answer there starts a new path.
    fireEvent.click(within(finder).getByRole('button', { name: /Which passport do you hold\? Vietnam/ }))
    expect(within(finder).getByRole('group', { name: 'Which passport do you hold?' })).toBeInTheDocument()
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 1, state: { answers: [] } }))
    fireEvent.click(within(finder).getByRole('button', { name: 'US, UK or EU' }))
    expect(finder).toHaveTextContent('No visa needed')
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 1, state: { answers: [0] } }))
  })

  it('opens on the outcome you reached before, and stops at an answer an older finder doesn’t have', () => {
    const { onChange } = keeper(visa.spec)
    const { rerender } = render(<AnswerWidgets widgets={[{ ...visa, state: { answers: [0] }, changedAt: '2026-11-08T09:00:00.000Z' }]} onChange={onChange} />)
    expect(screen.getByRole('region', { name: 'Do you need a visa for Japan?' })).toHaveTextContent('No visa needed')
    rerender(<AnswerWidgets widgets={[{ ...visa, state: { answers: [1, 7] }, changedAt: '2026-11-08T09:00:01.000Z' }]} onChange={onChange} />)
    expect(screen.getByRole('group', { name: 'How long will you stay?' })).toBeInTheDocument()
  })

  it('can’t be answered while the answer is still written', () => {
    const { onChange } = keeper(visa.spec)
    render(<AnswerWidgets widgets={[visa]} onChange={onChange} live />)
    for (const button of within(screen.getByRole('region', { name: 'Do you need a visa for Japan?' })).getAllByRole('button')) expect(button).toBeDisabled()
  })
})

describe('AnswerWidgets, a quiz', () => {
  it('settles a question once you pick, marks the right choice, says why, and keeps your picks', async () => {
    const { kept, onChange } = keeper(quiz.spec)
    render(<AnswerWidgets widgets={[quiz]} onChange={onChange} />)
    const card = screen.getByRole('region', { name: 'Check yourself' })
    expect(card).toHaveTextContent('0 of 2 answered')
    expect(card).not.toHaveTextContent('Light splits water')
    const first = within(card).getByRole('group', { name: 'Where does the oxygen come from?' })
    fireEvent.click(within(first).getByRole('button', { name: 'Carbon dioxide' }))
    expect(first.parentElement).toHaveTextContent('Not quite. Light splits water in the leaf.')
    expect(within(first).getByRole('button', { name: 'Carbon dioxide' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(first).getByRole('button', { name: 'Water, the right answer' })).toBeInTheDocument()
    // Settled, its choices say so, and the one you picked keeps its focus; a tap changes nothing.
    for (const button of within(first).getAllByRole('button')) expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(within(first).getByRole('button', { name: 'The soil' }))
    expect(within(first).getByRole('button', { name: 'Carbon dioxide' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(kept).toEqual([{ n: 2, state: { picked: [0, null] } }]))
    const second = within(card).getByRole('group', { name: 'What does the plant make?' })
    fireEvent.click(within(second).getByRole('button', { name: 'Sugar' }))
    expect(second.parentElement).toHaveTextContent('Right.')
    expect(card).toHaveTextContent('1 of 2 right')
    // Once all are answered, it can be started again.
    fireEvent.click(within(card).getByRole('button', { name: 'Start again' }))
    expect(card).toHaveTextContent('0 of 2 answered')
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 2, state: { picked: [null, null] } }))
  })

  it('says which is right when the agent gave no reason', () => {
    const { onChange } = keeper(quiz.spec)
    render(<AnswerWidgets widgets={[{ ...quiz, state: { picked: [null, 1] }, changedAt: '2026-11-08T09:00:00.000Z' }]} onChange={onChange} />)
    expect(screen.getByRole('group', { name: 'What does the plant make?' }).parentElement).toHaveTextContent('Not quite. The answer is “Sugar”.')
  })
})

describe('AnswerWidgets, a scale', () => {
  it('says in words where each figure stands, then draws the ranges and the figure to scale', () => {
    const { onChange } = keeper(fever.spec)
    render(<AnswerWidgets widgets={[fever]} onChange={onChange} />)
    const card = screen.getByRole('region', { name: 'Is 38.5 °C a fever?' })
    expect(within(card).getByRole('listitem')).toHaveTextContent('You38.5 °CFever')
    const ranges = within(card).getAllByTestId('wg-scale-range')
    expect(ranges.map((range) => range.style.width)).toEqual(['22%', '28%', '50%'])
    expect(ranges.map((range) => range.style.left)).toEqual(['0%', '22%', '50%'])
    expect(ranges.map((range) => range.className.includes('held'))).toEqual([false, false, true])
    expect(within(card).getByTestId('wg-scale-pin').style.left).toBe('70%')
    expect(card).toHaveTextContent('Low: 35.0 to 36.1 °C; Normal: 36.1 to 37.5 °C; Fever: 37.5 to 40.0 °C')
  })
})

describe('AnswerWidgets, a timeline', () => {
  it('writes each date one way, says how long a gap is, and puts today among events still to come', () => {
    vi.useFakeTimers({ now: new Date('2026-11-08T12:00:00') })
    const { onChange } = keeper(books.spec)
    const plan: KeptWidget = {
      n: 5,
      spec: { kind: 'timeline', title: 'Your visa', events: [{ date: '2026-10-01', label: 'Applied' }, { date: '2026-12-01', label: 'Interview' }] },
    }
    render(<AnswerWidgets widgets={[books, plan]} onChange={onChange} />)
    const card = screen.getByRole('region', { name: 'The Harry Potter books' })
    // A day is written as this computer writes dates (lib/widgets/timeline.test.ts tries two ways).
    const day = (year: number, month: number, date: number) => dateWritten({ year, month, day: date })
    expect(card.textContent).toBe(`The Harry Potter books${day(1997, 6, 26)}Philosopher’s StoneIn the UK1 year1998Chamber of Secrets9 years2007Deathly Hallows`)
    expect(card).not.toHaveTextContent('Today')
    const visaCard = screen.getByRole('region', { name: 'Your visa' })
    expect(visaCard.textContent).toBe(`Your visa${day(2026, 10, 1)}Applied38 daysToday23 days${day(2026, 12, 1)}Interview`)
  })
})
