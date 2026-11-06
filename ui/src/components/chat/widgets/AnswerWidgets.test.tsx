import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearContext } from '../../../lib/chat/appear'
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

  it('draws a picture in our own lines and turns the part you pick gold', () => {
    const takeOff: KeptWidget = {
      n: 7,
      spec: {
        kind: 'picture',
        title: 'How a plane takes off',
        width: 640,
        height: 320,
        shapes: [
          { d: 'M20 300L620 300', dashed: true },
          { d: 'M60 280L140 280L150 274Z', part: 1, fill: 'light' },
          { d: 'M80 284C80 286 82 288 84 288Z', part: 1, fill: 'dark' },
          { d: 'M300 240L380 220Z', part: 2, fill: 'light' },
          { d: '"/><script>alert(1)</script>', part: 2 },
          // A shade the app doesn't know is a light one, never a class of its own.
          { d: 'M10 10L20 20Z', fill: 'ghost' as unknown as 'light' },
        ],
        parts: [
          { label: 'Speed up', text: 'The engines push it along.', at: [100, 250] },
          { label: 'Climb', text: 'The nose rises.', at: [340, 200] },
        ],
      },
    }
    const { container } = render(<AnswerWidgets widgets={[takeOff]} onChange={keeper().onChange} />)
    const picture = screen.getByRole('region', { name: 'How a plane takes off' })
    const shapes = [...container.querySelectorAll('.wg-figure path')]
    // Only what the daemon writes is drawn: moves, lines, curves.
    expect(shapes.map((shape) => shape.getAttribute('d'))).toEqual(['M20 300L620 300', 'M60 280L140 280L150 274Z', 'M80 284C80 286 82 288 84 288Z', 'M300 240L380 220Z', 'M10 10L20 20Z'])
    expect(shapes[4]).toHaveClass('loose', 'light')
    expect(shapes[4]).not.toHaveClass('ghost')
    expect(shapes[0]).toHaveClass('wg-shape', 'loose', 'dashed')
    expect(shapes[2]).toHaveClass('dark')
    const gold = () => shapes.filter((shape) => shape.classList.contains('on'))
    expect(gold()).toEqual([shapes[1], shapes[2]])
    expect(picture).toHaveTextContent('1 of 2 · Speed upThe engines push it along.')
    // Its number stands where the part says, on the picture.
    const climb = within(picture).getByRole('button', { name: 'Part 2: Climb' })
    expect(climb.style.left).toBe('53.125%')
    expect(climb.style.top).toBe('62.5%')
    fireEvent.click(climb)
    expect(gold()).toEqual([shapes[3]])
    expect(climb).toHaveAttribute('aria-pressed', 'true')
    expect(picture).toHaveTextContent('2 of 2 · ClimbThe nose rises.')
    // A screen reader hears the part's words, not only its name.
    expect(picture.querySelector('[aria-live]')).toHaveTextContent('2 of 2 · ClimbThe nose rises.')
    // Next goes round to the first; before, back to the last.
    fireEvent.click(within(picture).getByRole('button', { name: 'Next part' }))
    expect(picture).toHaveTextContent('1 of 2 · Speed up')
    fireEvent.click(within(picture).getByRole('button', { name: 'Part before' }))
    expect(picture).toHaveTextContent('2 of 2 · Climb')
  })

  it('draws a picture with no parts as a picture alone', () => {
    const plain: KeptWidget = { n: 8, spec: { kind: 'picture', title: 'A heron', width: 640, height: 480, shapes: [{ d: 'M0 0L10 10', part: undefined }] } }
    const { container } = render(<AnswerWidgets widgets={[plain]} onChange={keeper().onChange} />)
    const picture = screen.getByRole('region', { name: 'A heron' })
    expect(container.querySelectorAll('.wg-figure path')).toHaveLength(1)
    expect(within(picture).queryAllByRole('button')).toHaveLength(0)
    expect(picture).not.toHaveTextContent('of')
  })
})

const relevance: KeptWidget = {
  n: 5,
  spec: {
    kind: 'calculator',
    title: 'Select relevant documents',
    inputs: ['#1', '#2', '#3', '#4', '#5'].map((label, at) => ({ id: `d${at + 1}`, label, on: at > 0 && at < 4, group: 'Relevant?' })),
    results: [
      { id: 'found', label: 'Recall@5', formula: '(d1 + d2 + d3 + d4 + d5) / 3', decimals: 3, note: '{d1 + d2 + d3 + d4 + d5} / 3 found' },
      { id: 'rr', label: 'RR@5', formula: 'if(d1, 1, if(d2, 1/2, if(d3, 1/3, 0)))', decimals: 3, note: 'First at #{if(d1, 1, if(d2, 2, 3))}' },
    ],
    presets: [{ label: 'Try moving relevant documents to the top', values: { d1: true, d2: true, d3: true, d4: false } }],
  },
}

describe('AnswerWidgets, new parts', () => {
  it('draws a group’s switches as one row of boxes, says why under each result, and sets a preset', async () => {
    const { kept, onChange } = keeper()
    render(<AnswerWidgets widgets={[relevance]} onChange={onChange} />)
    const calculator = screen.getByRole('region', { name: 'Select relevant documents' })
    const row = within(calculator).getByRole('group', { name: 'Relevant?' })
    expect(within(row).getAllByRole('button')).toHaveLength(5)
    expect(within(row).getByRole('button', { name: '#2' })).toHaveAttribute('aria-pressed', 'true')
    expect(calculator).toHaveTextContent('Recall@51.0003 / 3 found')
    expect(calculator).toHaveTextContent('RR@50.500First at #2')

    fireEvent.click(within(row).getByRole('button', { name: '#1' }))
    expect(calculator).toHaveTextContent('RR@51.000First at #1')
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 5, state: { values: { d1: true } } }))

    // #5 isn't one the preset names: it goes back to its start, off.
    fireEvent.click(within(row).getByRole('button', { name: '#5' }))
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 5, state: { values: { d1: true, d5: true } } }))
    const preset = within(calculator).getByRole('button', { name: 'Try moving relevant documents to the top' })
    expect(preset).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(preset)
    await waitFor(() => expect(kept.at(-1)).toEqual({ n: 5, state: { values: { d1: true, d2: true, d3: true, d4: false } } }))
    expect(preset).toHaveAttribute('aria-pressed', 'true')
    expect(within(row).getByRole('button', { name: '#4' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(row).getByRole('button', { name: '#5' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('draws marks with their words, a flow in order, and a graph you can read point by point', () => {
    const marks: KeptWidget = { n: 6, spec: { kind: 'marks', title: 'Top 5 retrieved documents', cells: [{ label: '#1', mark: 'no', note: 'Irrelevant' }, { label: '#2', mark: 'yes', note: 'Relevant' }, { label: '#3', mark: 'neither' }], facts: ['2 relevant documents retrieved out of 3'] } }
    const flow: KeptWidget = { n: 7, spec: { kind: 'flow', title: 'A RAG pipeline', boxes: [{ label: 'User query' }, { label: 'Retriever', note: 'Recall@K: coverage' }, { label: 'Reranker' }], repeats: true } }
    const graph: KeptWidget = { n: 8, spec: { kind: 'graph', title: 'Rent', style: 'line', labels: ['Jan', 'Feb', 'Mar'], series: [{ label: 'Flat', values: [1200, 1250, 1300] }, { label: 'House', values: [2000, 2000, 2100] }], prefix: '$' } }
    render(<AnswerWidgets widgets={[marks, flow, graph]} onChange={keeper().onChange} />)

    const row = screen.getByRole('region', { name: 'Top 5 retrieved documents' })
    expect(within(row).getByLabelText('#2: Yes, Relevant')).toBeInTheDocument()
    expect(within(row).getByLabelText('#3: Neither yes nor no')).toBeInTheDocument()
    expect(row).toHaveTextContent('2 relevant documents retrieved out of 3')

    const steps = within(screen.getByRole('region', { name: 'A RAG pipeline' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual(['User query', 'RetrieverRecall@K: coverage', 'Reranker'])
    expect(screen.getByRole('img', { name: 'Then back to User query' })).toBeInTheDocument()

    const plot = screen.getByRole('region', { name: 'Rent' })
    expect(plot).toHaveTextContent('Mar: Flat $1,300, House $2,100')
    fireEvent.keyDown(within(plot).getByRole('group'), { key: 'ArrowLeft' })
    expect(plot).toHaveTextContent('Feb: Flat $1,250, House $2,000')
    const table = within(plot).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(table).toHaveTextContent('Jan$1,200$2,000')
  })

  it('draws widgets while the answer is still written, and keeps nothing until it is done', () => {
    const { onChange } = keeper()
    const onChoose = vi.fn()
    render(<AnswerWidgets widgets={[relevance, checklist, choices, trip]} onChange={onChange} onChoose={onChoose} live />)
    for (const button of within(screen.getByRole('region', { name: 'Select relevant documents' })).getAllByRole('button')) expect(button).toBeDisabled()
    const zoo = screen.getByRole('region', { name: 'Zoo trip' })
    expect(within(zoo).getByLabelText('Pupils')).toBeDisabled()
    expect(within(zoo).getByRole('switch', { name: 'Round up' })).toBeDisabled()
    for (const button of within(zoo).getAllByRole('button')) expect(button).toBeDisabled()
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled()
    for (const button of within(screen.getByRole('region', { name: 'Which theme?' })).getAllByRole('button')) expect(button).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AnswerWidgets, compare and counted', () => {
  const plans: KeptWidget = {
    n: 9,
    spec: {
      kind: 'compare',
      title: 'Two phone plans',
      whole: { label: 'Your family’s lines', note: 'Four phones' },
      sides: [{ label: 'Basic', value: 100, note: 'Shared data' }, { label: 'Unlimited', value: 435 }],
      rows: [{ label: 'Data', values: ['20 GB shared', 'Unlimited'] }, { label: 'Calls abroad', values: ['By the minute', 'Included'] }],
      unit: 'minutes',
    },
  }

  it('draws the parts of one thing side by side, each figure to scale, with facts read across', () => {
    render(<AnswerWidgets widgets={[plans]} onChange={keeper().onChange} />)
    const compare = screen.getByRole('region', { name: 'Two phone plans' })
    // A screen reader reads it as a table: the sides across the top, a fact on each row.
    const table = within(compare).getByRole('table')
    expect(table).toHaveTextContent('Two phone plans: Your family’s lines, Four phones')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Basic', 'Unlimited'])
    const rows = within(table).getAllByRole('row').map((row) => [...row.children].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['', 'Basic', 'Unlimited'],
      ['minutes', '100 minutes', '435 minutes'],
      ['Note', 'Shared data', ''],
      ['Data', '20 GB shared', 'Unlimited'],
      ['Calls abroad', 'By the minute', 'Included'],
    ])
    // Drawn: the whole joined to each side, and each figure a rule from one zero.
    const drawn = within(compare).getByTestId('wg-compare')
    expect(drawn).toHaveTextContent('Your family’s lines')
    expect(drawn.querySelector('.wg-tree')).not.toBeNull()
    const [basic, unlimited] = within(compare).getAllByTestId('wg-side-scale')
    expect(parseFloat(basic.style.width)).toBeCloseTo((100 / 435) * 100, 5)
    expect(unlimited.style.width).toBe('100%')
    // A fact's values sit under their sides, in the sides' order.
    const facts = [...drawn.querySelectorAll('.wg-row')].map((row) => [...row.children].map((cell) => cell.textContent))
    expect(facts).toEqual([['Data', '20 GB shared', 'Unlimited'], ['Calls abroad', 'By the minute', 'Included']])
    expect(within(compare).queryAllByTestId('wg-dots')).toHaveLength(0)
  })

  it('draws figures that count whole things as a dot each, or a round number each when too many', () => {
    const seats: KeptWidget = { n: 10, spec: { kind: 'compare', title: 'Two houses', unit: 'seats', counted: true, sides: [{ label: 'Upper', value: 100 }, { label: 'Lower', value: 435 }] } }
    const crowd: KeptWidget = { n: 11, spec: { kind: 'compare', title: 'Two halls', unit: 'people', counted: true, sides: [{ label: 'Small', value: 300 }, { label: 'Big', value: 1203 }] } }
    render(<AnswerWidgets widgets={[seats, crowd]} onChange={keeper().onChange} />)
    const houses = screen.getByRole('region', { name: 'Two houses' })
    const [upper, lower] = within(houses).getAllByTestId('wg-dots')
    expect(upper.querySelectorAll('i')).toHaveLength(100)
    expect(lower.querySelectorAll('i')).toHaveLength(435)
    // A dot for each seat needs no key: the figure is written above the dots.
    expect(houses).not.toHaveTextContent('= 1')
    expect(within(houses).queryAllByTestId('wg-side-scale')).toHaveLength(0)
    // 1,203 won't fit a dot each: a dot is 5 people, and the 3 left over are part of one more.
    const halls = screen.getByRole('region', { name: 'Two halls' })
    const [small, big] = within(halls).getAllByTestId('wg-dots')
    expect(small.querySelectorAll('i')).toHaveLength(60)
    expect(big.querySelectorAll('i')).toHaveLength(241)
    expect(big.querySelector('i.part')).toHaveStyle({ '--part': '0.6' })
    expect(halls).toHaveTextContent('= 5 people')
  })

  it('draws a counted chart as lines of dots, each figure still written beside its line', () => {
    const states: KeptWidget = { n: 12, spec: { kind: 'chart', title: 'Seats by state', unit: 'seats', counted: true, bars: [{ label: 'California', value: 52 }, { label: 'Texas', value: 38 }, { label: 'Wyoming', value: 1 }] } }
    render(<AnswerWidgets widgets={[states]} onChange={keeper().onChange} />)
    const chart = screen.getByRole('region', { name: 'Seats by state' })
    expect(within(chart).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['California52 seats', 'Texas38 seats', 'Wyoming1 seats'])
    expect(within(chart).getAllByTestId('wg-dots').map((line) => line.querySelectorAll('i').length)).toEqual([52, 38, 1])
    // Tens are set apart, so a line can be counted.
    expect(within(chart).getAllByTestId('wg-dots')[0].querySelectorAll('b')).toHaveLength(5)
    expect(within(chart).queryAllByTestId('wg-bar-fill')).toHaveLength(0)
    expect(chart).not.toHaveTextContent('= 1')
  })

  it('runs a flow across while each stop has room, and down when it hasn’t', () => {
    const flow: KeptWidget = { n: 13, spec: { kind: 'flow', title: 'From bill to law', boxes: [{ label: 'One house votes' }, { label: 'The other votes' }, { label: 'Signed' }, { label: 'Law' }] } }
    const { unmount } = render(<AnswerWidgets widgets={[flow]} onChange={keeper().onChange} />)
    const route = () => screen.getByRole('region', { name: 'From bill to law' }).querySelector('.wg-route')
    expect(route()).toHaveClass('across')
    // The stops read as their words: the numbers are drawn, not written.
    expect(within(screen.getByRole('region', { name: 'From bill to law' })).getAllByRole('listitem').map((stop) => stop.textContent)).toEqual(['One house votes', 'The other votes', 'Signed', 'Law'])
    unmount()
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect)
    render(<AnswerWidgets widgets={[flow]} onChange={keeper().onChange} />)
    expect(route()).toHaveClass('down')
    measure.mockRestore()
  })

  it('grows in when it arrives as news, once; history and a widget drawn again are simply there', () => {
    const once: KeptWidget = { n: 14, spec: { kind: 'chart', title: 'Drawn once', bars: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] } }
    const history: KeptWidget = { n: 17, spec: { kind: 'chart', title: 'Read back', bars: [{ label: 'a', value: 3 }, { label: 'b', value: 4 }] } }
    const shell = (title: string) => screen.getByRole('region', { name: title }).parentElement
    // An older page read back: not news, so nothing moves, then or later.
    const old = render(<AppearContext.Provider value={false}><AnswerWidgets widgets={[history]} onChange={keeper().onChange} /></AppearContext.Provider>)
    expect(shell('Read back')).not.toHaveClass('wg-fresh')
    old.unmount()
    const first = render(<AppearContext.Provider value={true}><AnswerWidgets widgets={[once, { ...history, n: 18 }]} onChange={keeper().onChange} /></AppearContext.Provider>)
    expect(shell('Drawn once')).toHaveClass('wg-fresh')
    expect(shell('Read back')).not.toHaveClass('wg-fresh')
    first.unmount()
    render(<AppearContext.Provider value={true}><AnswerWidgets widgets={[{ ...once, n: 15 }]} onChange={keeper().onChange} /></AppearContext.Provider>)
    expect(shell('Drawn once')).not.toHaveClass('wg-fresh')
  })

  it('runs a route down when a word of its labels wouldn’t fit across, rather than break it', () => {
    const words: KeptWidget = { n: 19, spec: { kind: 'flow', title: 'Signing in', boxes: [{ label: 'Username' }, { label: 'Internationalisation' }, { label: 'Session' }, { label: 'Done' }] } }
    render(<AnswerWidgets widgets={[words]} onChange={keeper().onChange} />)
    // 480 px across four stops is 120 each; "Internationalisation" needs about 162 with its room.
    expect(screen.getByRole('region', { name: 'Signing in' }).querySelector('.wg-route')).toHaveClass('down')
  })

  it('shows how much of a checklist is done as a line under its title', () => {
    const three: KeptWidget = { n: 16, spec: { kind: 'checklist', title: 'Three things', items: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] }, state: { checked: [true, false, false] } }
    render(<AnswerWidgets widgets={[three]} onChange={keeper().onChange} />)
    // What is done, not what is left.
    expect(parseFloat(screen.getByTestId('wg-progress').style.width)).toBeCloseTo(100 / 3, 5)
  })

  it('reads figures without a unit as a "Number" row, and ends steps that repeat on the first one’s name', () => {
    const plain: KeptWidget = { n: 20, spec: { kind: 'compare', title: 'Two lines', sides: [{ label: 'Basic', value: 4 }, { label: 'Unlimited', value: 12 }] } }
    render(<AnswerWidgets widgets={[plain, { ...water, n: 21 }]} onChange={keeper().onChange} />)
    const table = within(screen.getByRole('region', { name: 'Two lines' })).getByRole('table')
    expect([...within(table).getAllByRole('row')[1].children].map((cell) => cell.textContent)).toEqual(['Number', '4', '12'])
    expect(screen.getByRole('img', { name: 'Then back to step 1' })).toHaveTextContent('Evaporation')
  })
})
