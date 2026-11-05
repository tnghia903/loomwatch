import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { RunEvent } from '../watch/events'
import { partsOf, place, placedSoFar, shownSoFar, withoutPartPlace, wordsOf } from './place'
import type { KeptWidget, WidgetSpec } from './types'

// The same cases the daemon reads (crates/loomwatch-backend/src/widgets/mod.rs `place`), so a
// widget written into place stays where it is when the answer is kept.
interface Cases { cases: { name: string; reply: string; places: (number | null)[]; words: string; lines: (number | null)[] }[] }
const cases = JSON.parse(readFileSync(resolve(process.cwd(), '../schemas/widget-place.cases.json'), 'utf8')) as Cases

const list: WidgetSpec = { kind: 'checklist', title: 'Before Wednesday', items: [{ text: 'Print 32 copies' }] }

describe('place', () => {
  it('reads every case', () => expect(cases.cases.length).toBeGreaterThan(5))
  for (const c of cases.cases) {
    it(c.name, () => expect(place(c.reply, c.places)).toEqual({ words: c.words, lines: c.lines }))
  }

  it('cuts the words where the widgets stand, the unplaced last', () => {
    const at = (n: number, line?: number): KeptWidget => ({ n, line, spec: list })
    const { parts, end } = partsOf('One.\n\nTwo.\n\nThree.', [at(1, 2), at(2), at(3, 2), at(4, 0), at(5, 9)])
    expect(parts.map((part) => [part.text, part.widgets.map((kept) => kept.n)])).toEqual([
      ['', [4]],
      ['One.\n', [1, 3]],
      ['Two.\n\nThree.', []],
    ])
    expect(end.map((kept) => kept.n)).toEqual([2, 5])
  })

  it('shows words without place lines where widgets aren’t drawn, and other words exactly', () => {
    expect(wordsOf('Here it is.\n\n{{widget 1}}\n\nTry it.')).toBe('Here it is.\n\nTry it.')
    expect(wordsOf('Writing:\n\n{{widg')).toBe('Writing:')
    expect(wordsOf('Plain words\n')).toBe('Plain words\n')
  })

  it('hides a place line still being written', () => {
    expect(withoutPartPlace('Look:\n\n{{wid')).toBe('Look:\n\n')
    expect(withoutPartPlace('Look:\n\n{{widget 1}')).toBe('Look:\n\n')
    expect(withoutPartPlace('Look:\n\n{{widget 1}}')).toBe('Look:\n\n{{widget 1}}')
    expect(withoutPartPlace('The {{name}} stays')).toBe('The {{name}} stays')
    expect(withoutPartPlace('A {{ brace')).toBe('A {{ brace')
  })

  it('places what the agent has shown as it writes, once its place line is written', () => {
    const event = (seq: number, kind: RunEvent['kind'], payload: Record<string, unknown>, agentId = 'writer'): RunEvent => ({ id: `e${seq}`, sessionId: 'run', agentId, seq, ts: '2026-11-05T10:00:00Z', kind, payload })
    const events = [
      event(1, 'tool_call', { callId: 'a', name: 'show_widget', rawInput: list }),
      event(2, 'tool_update', { callId: 'a', status: 'completed', rawOutput: { place: '{{widget 1}}' } }),
      event(3, 'tool_call', { callId: 'b', name: 'show_widget', rawInput: { ...list, title: 'Refused' } }),
      event(4, 'tool_update', { callId: 'b', status: 'failed', rawOutput: { error: 'no', place: '{{widget 3}}' } }),
      event(5, 'tool_call', { callId: 'c', name: 'show_widget', rawInput: { ...list, title: 'Someone else’s' } }, 'researcher'),
      event(6, 'tool_update', { callId: 'c', status: 'completed', rawOutput: { place: '{{widget 2}}' } }, 'researcher'),
    ]
    const shown = shownSoFar(events, 'writer')
    expect([...shown.keys()]).toEqual([1])
    expect(placedSoFar('Do these first:\n\n', shown)).toEqual({ words: 'Do these first:\n\n', widgets: [] })
    expect(placedSoFar('Do these first:\n\n{{widget 1}}\n\nThen', shown)).toEqual({ words: 'Do these first:\n\nThen', widgets: [{ n: 1, line: 2, spec: list }] })
  })
})
