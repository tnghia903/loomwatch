import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'

afterEach(() => { cleanup(); vi.useRealTimers() })

const choices: KeptWidget = { n: 1, spec: { kind: 'choices', title: 'Which theme?', options: [{ label: 'Animals', detail: 'rabbit, giraffe' }, { label: 'Food' }, { label: 'Weather' }] } }
const checklist: KeptWidget = { n: 2, spec: { kind: 'checklist', title: 'Before Wednesday', items: [{ text: 'Print 32 copies', note: 'Tue' }, { text: 'Read the words aloud' }] } }
const trip: KeptWidget = {
  n: 3,
  spec: {
    kind: 'calculator',
    title: 'Zoo trip',
    inputs: [
      { id: 'pupils', label: 'Pupils', start: 32, min: 1, max: 60, step: 1 },
      { id: 'bus', label: 'Bus', start: 2400000, unit: '₫' },
      { id: 'ticket', label: 'Ticket', start: 60000, unit: '₫' },
      { id: 'round_up', label: 'Round up', on: true },
    ],
    results: [
      { id: 'each', label: 'Each family pays', formula: '(bus + pupils * ticket) / pupils', unit: '₫', decimals: 0 },
      { id: 'rounded', label: 'Rounded', formula: 'if(round_up, ceil(each, -4), each)', unit: '₫' },
    ],
  },
}
const senate: KeptWidget = { n: 5, spec: { kind: 'chart', title: 'US Senate after the midterms', unit: 'seats', bars: [{ label: 'Democrats', value: 51, note: '+4' }, { label: 'Republicans', value: 49 }] } }
const markets: KeptWidget = { n: 6, spec: { kind: 'chart', title: 'Markets on Wednesday', unit: '%', decimals: 1, bars: [{ label: 'S&P 500', value: 2.36 }, { label: 'Nikkei', value: -0.4 }, { label: 'FTSE', value: 0 }] } }
const water: KeptWidget = { n: 4, spec: { kind: 'steps', title: 'The water cycle', repeats: true, steps: [{ label: 'Evaporation', text: 'The sun warms the sea.' }, { label: 'Condensation', text: 'The drops make a cloud.' }, { label: 'Rain', text: 'Heavy drops fall.' }] } }

/** The daemon, keeping what it is sent: what `onChange` answers. */
function keeper() {
  const kept: { n: number; state: WidgetState }[] = []
  const onChange = vi.fn(async (n: number, state: WidgetState) => {
    kept.push({ n, state })
    return { n, spec: choices.spec, state, changedAt: `2026-11-05T10:00:0${kept.length}.000Z` }
  })
  return { kept, onChange }
}

describe('AnswerWidgets', () => {
  it('sends the choice you tap as your message, once, and keeps it marked', () => {
    const onChoose = vi.fn()
    render(<AnswerWidgets widgets={[choices]} onChange={keeper().onChange} onChoose={onChoose} />)
    const group = screen.getByRole('region', { name: 'Which theme?' })
    expect(group).toHaveTextContent('rabbit, giraffe')
    fireEvent.click(within(group).getByRole('button', { name: /Food/ }))
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('Food')
    expect(within(group).getByRole('button', { name: /Food/ })).toHaveAttribute('aria-pressed', 'true')
    // A second tap sends nothing more: the box is there for anything else.
    fireEvent.click(within(group).getByRole('button', { name: /Animals/ }))
    expect(onChoose).toHaveBeenCalledOnce()
    expect(within(group).getByRole('button', { name: /Animals/ })).toBeDisabled()
  })

  it('shows the choice already sent, and none can be tapped on an answer that isn’t the newest', () => {
    render(<AnswerWidgets widgets={[choices]} onChange={keeper().onChange} chosen="Weather" />)
    const group = screen.getByRole('region', { name: 'Which theme?' })
    expect(within(group).getByRole('button', { name: /Weather/ })).toHaveAttribute('aria-pressed', 'true')
    for (const button of within(group).getAllByRole('button')) expect(button).toBeDisabled()
  })

  it('keeps each tick, and a page read before it was kept doesn’t undo it', async () => {
    const { kept, onChange } = keeper()
    const { rerender } = render(<AnswerWidgets widgets={[checklist]} onChange={onChange} />)
    const list = screen.getByRole('region', { name: 'Before Wednesday' })
    expect(list).toHaveTextContent('0 of 2 done')
    fireEvent.click(within(list).getByRole('checkbox', { name: /Print 32 copies/ }))
    expect(within(list).getByRole('checkbox', { name: /Print 32 copies/ })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(kept).toEqual([{ n: 2, state: { checked: [true, false] } }]))
    // The chat reads its page again, from before the tick was kept.
    rerender(<AnswerWidgets widgets={[{ ...checklist }]} onChange={onChange} />)
    expect(within(list).getByRole('checkbox', { name: /Print 32 copies/ })).toHaveAttribute('aria-checked', 'true')
    expect(list).toHaveTextContent('1 of 2 done')
    // Then a page with it kept, and later another device's change: the page's is shown.
    rerender(<AnswerWidgets widgets={[{ ...checklist, state: { checked: [false, true] }, changedAt: '2026-11-05T11:00:00.000Z' }]} onChange={onChange} />)
    expect(within(list).getByRole('checkbox', { name: /Read the words aloud/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(list).getByRole('checkbox', { name: /Print 32 copies/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('says a tick couldn’t be kept, and shows the list as it was', async () => {
    const onChange = vi.fn(async () => { throw new Error('LoomWatch couldn’t keep that.') })
    render(<AnswerWidgets widgets={[checklist]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Print 32 copies/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('LoomWatch couldn’t keep that.')
    expect(screen.getByRole('checkbox', { name: /Print 32 copies/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('works a calculator’s results out as you change it, shows the sum, and keeps it once you stop', async () => {
    vi.useFakeTimers()
    const { kept, onChange } = keeper()
    render(<AnswerWidgets widgets={[trip]} onChange={onChange} />)
    const calc = screen.getByRole('region', { name: 'Zoo trip' })
    expect(calc).toHaveTextContent('Each family pays135,000 ₫(2,400,000 + 32 × 60,000) ÷ 32')
    // A formula with a function in it is worked out, but its sum isn't shown: it would read as code.
    expect(calc).toHaveTextContent('Rounded140,000 ₫')
    expect(calc).not.toHaveTextContent('ceil')

    const pupils = within(calc).getByRole('textbox', { name: 'Pupils' })
    fireEvent.change(pupils, { target: { value: '2' } })
    fireEvent.change(pupils, { target: { value: '25' } })
    expect(calc).toHaveTextContent('Each family pays156,000 ₫')
    expect(calc).toHaveTextContent('Rounded160,000 ₫')
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(700) })
    expect(kept).toEqual([{ n: 3, state: { values: { pupils: 25 } } }])

    // A switch is kept at once.
    fireEvent.click(within(calc).getByRole('switch', { name: 'Round up' }))
    expect(calc).toHaveTextContent('Rounded156,000 ₫')
    await act(async () => { await Promise.resolve() })
    expect(kept.at(-1)).toEqual({ n: 3, state: { values: { pupils: 25, round_up: false } } })
  })

  it('refuses a number outside the calculator’s range, says what it takes, and keeps nothing', async () => {
    vi.useFakeTimers()
    const { onChange } = keeper()
    render(<AnswerWidgets widgets={[trip]} onChange={onChange} />)
    const pupils = screen.getByRole('textbox', { name: 'Pupils' })
    fireEvent.change(pupils, { target: { value: '0' } })
    expect(pupils).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('region', { name: 'Zoo trip' })).toHaveTextContent('A number from 1 to 60')
    expect(screen.getByRole('region', { name: 'Zoo trip' })).toHaveTextContent('Each family pays135,000 ₫')
    await act(async () => { vi.advanceTimersByTime(700) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('asks for commas when thousands are written with dots, and is never red while a number is typed', () => {
    render(<AnswerWidgets widgets={[trip]} onChange={keeper().onChange} />)
    const calc = screen.getByRole('region', { name: 'Zoo trip' })
    const ticket = within(calc).getByRole('textbox', { name: 'Ticket' })
    fireEvent.change(ticket, { target: { value: '60.000' } })
    expect(ticket).toHaveAttribute('aria-invalid', 'true')
    expect(ticket).toHaveAccessibleDescription('Write thousands with a comma, like 60,000. Still worked out with 60,000.')
    expect(calc).toHaveTextContent('Each family pays135,000 ₫')
    for (const unfinished of ['', '-', '6.']) {
      fireEvent.change(ticket, { target: { value: unfinished } })
      expect(ticket).not.toHaveAttribute('aria-invalid')
    }
    fireEvent.change(ticket, { target: { value: 'sixty' } })
    expect(ticket).toHaveAccessibleDescription('A number, like 60,000. Still worked out with 60,000.')
  })

  it('unmarks a choice whose message couldn’t be sent', async () => {
    const onChoose = vi.fn(async () => false)
    render(<AnswerWidgets widgets={[choices]} onChange={keeper().onChange} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: /Food/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Food/ })).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.getByRole('button', { name: /Food/ })).toBeEnabled()
  })

  it('steps a number by its step, within its range', async () => {
    const { kept, onChange } = keeper()
    render(<AnswerWidgets widgets={[trip]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'More: Pupils' }))
    expect(screen.getByRole('textbox', { name: 'Pupils' })).toHaveValue('33')
    await waitFor(() => expect(kept).toEqual([{ n: 3, state: { values: { pupils: 33 } } }]))
  })

  it('draws a chart’s bars to scale from one zero, each with its figure written beside it', () => {
    render(<AnswerWidgets widgets={[senate]} onChange={keeper().onChange} />)
    const chart = screen.getByRole('region', { name: 'US Senate after the midterms' })
    const rows = within(chart).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['Democrats51 seats +4', 'Republicans49 seats'])
    const fills = within(chart).getAllByTestId('wg-bar-fill')
    // The largest figure is the whole track; the next is its share of it.
    expect(fills[0]).toHaveStyle({ left: '0%', width: '100%' })
    expect(fills[1].style.width).toMatch(/^96\.07\d*%$/u)
    // Nothing to press: a chart is for reading.
    expect(within(chart).queryAllByRole('button')).toHaveLength(0)
  })

  it('runs a figure below zero left of the zero line, and writes figures as the daemon does', () => {
    render(<AnswerWidgets widgets={[markets]} onChange={keeper().onChange} />)
    const chart = screen.getByRole('region', { name: 'Markets on Wednesday' })
    expect(within(chart).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['S&P 5002.4 %', 'Nikkei-0.4 %', 'FTSE0.0 %'])
    const [up, down, flat] = within(chart).getAllByTestId('wg-bar-fill')
    // 2.36 above zero and 0.4 below share the track: zero sits at 0.4 / 2.76 of it.
    const zero = (0.4 / 2.76) * 100
    expect(parseFloat(up.style.left)).toBeCloseTo(zero, 5)
    expect(parseFloat(up.style.width)).toBeCloseTo((2.36 / 2.76) * 100, 5)
    expect(parseFloat(down.style.left)).toBeCloseTo(0, 5)
    expect(parseFloat(down.style.width)).toBeCloseTo(zero, 5)
    expect(down).toHaveClass('below')
    expect(parseFloat(flat.style.width)).toBe(0)
  })

  it('shows the step you tap, with one control per step, and marks steps that repeat', () => {
    render(<AnswerWidgets widgets={[water]} onChange={keeper().onChange} />)
    const steps = screen.getByRole('region', { name: 'The water cycle' })
    expect(steps).toHaveTextContent('1 of 3 · EvaporationThe sun warms the sea.')
    fireEvent.click(within(steps).getByRole('button', { name: /Rain/ }))
    expect(steps).toHaveTextContent('3 of 3 · RainHeavy drops fall.')
    expect(within(steps).getByRole('button', { name: /Rain/ })).toHaveAttribute('aria-pressed', 'true')
    // The steps themselves are the only buttons, and the mark that they repeat is neither a step
    // nor a button.
    expect(within(steps).getAllByRole('button')).toHaveLength(3)
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3)
    expect(within(steps).getByRole('img', { name: 'Then back to step 1' })).toBeInTheDocument()
  })
})
