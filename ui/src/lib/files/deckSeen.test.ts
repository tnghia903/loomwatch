import type { Element, Slide } from 'pptxtojson'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deckChanges, deckSeen, rememberSeen, seenBefore } from './deckSeen'
import type { ParsedDeck } from './slidesPage'

const words = (said: string, id = '1', order = 1) => ({ type: 'text', id, order, name: 'Text', left: 10, top: 10, width: 100, height: 20, content: `<p>${said}</p>` }) as unknown as Element
const slide = (parts: Element[], note = ''): Slide => ({ fill: { type: 'color', value: '#FFFFFF' }, elements: parts, layoutElements: [], note })
const deck = (...slides: Slide[]): ParsedDeck => ({ size: { width: 960, height: 540 }, slides })
/** What changed, as plain lists, to compare. */
const told = (changes: ReturnType<typeof deckChanges>) => changes && {
  slides: [...changes.slides],
  parts: Object.fromEntries([...changes.parts].map(([slide, parts]) => [slide, [...parts]])),
  notes: [...changes.notes],
}

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('what changed in a deck since it was seen', () => {
  it('tells nothing the first time, with nothing to tell it from', () => {
    expect(deckChanges(null, deckSeen(deck(slide([words('One')]))))).toBeNull()
  })

  it('marks the slide, the part and the notes that changed, and nothing else', () => {
    const before = deckSeen(deck(slide([words('Title'), words('Box: Snapshot export (code built)', '2', 2)]), slide([words('Two')], 'Say hello.'), slide([words('Three')])))
    const after = deckSeen(deck(slide([words('Title'), words('Box: Snapshot export', '2', 2)]), slide([words('Two')], 'Say hello first.'), slide([words('Three')])))
    expect(told(deckChanges(before, after))).toEqual({ slides: [0, 1], parts: { 0: [1] }, notes: [1] })
  })

  it('takes a deck written again by its script, its parts renumbered, as the same deck', () => {
    const before = deckSeen(deck(slide([words('Title', '7', 3)])))
    const after = deckSeen(deck(slide([words('Title', '42', 9)])))
    expect(told(deckChanges(before, after))).toEqual({ slides: [], parts: {}, notes: [] })
  })

  it('takes a slide moved to another place as moved, not changed, and a new slide as new, its parts not told one by one', () => {
    const one = slide([words('One')])
    const two = slide([words('Two')])
    const before = deckSeen(deck(one, two))
    expect(told(deckChanges(before, deckSeen(deck(two, one))))).toEqual({ slides: [], parts: {}, notes: [] })
    expect(told(deckChanges(before, deckSeen(deck(one, two, slide([words('Three'), words('Four', '2')])))))).toEqual({ slides: [2], parts: {}, notes: [] })
  })
})

describe('the deck last seen, kept in this browser', () => {
  it('keeps the version last shown of each deck, the latest forty', () => {
    const seen = deckSeen(deck(slide([words('One')])))
    rememberSeen('/w/deck.pptx', seen)
    expect(seenBefore('/w/deck.pptx')).toEqual(seen)
    expect(seenBefore('/w/other.pptx')).toBeNull()
    for (let index = 0; index < 40; index += 1) rememberSeen(`/w/deck-${index}.pptx`, seen)
    expect(seenBefore('/w/deck.pptx')).toBeNull()
    expect(seenBefore('/w/deck-39.pptx')).toEqual(seen)
    expect(seenBefore('/w/deck-0.pptx')).toEqual(seen)
  })

  it('tells nothing, rather than wrongly, when the browser keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => '{not json')
    expect(() => rememberSeen('/w/deck.pptx', deckSeen(deck(slide([]))))).not.toThrow()
    expect(seenBefore('/w/deck.pptx')).toBeNull()
  })
})
