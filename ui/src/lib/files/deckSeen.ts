import type { ParsedDeck } from './slidesPage'

/**
 * A deck as it was seen: a fingerprint of each slide, of each of its parts and of its notes, so a
 * later version can be told apart from it slide by slide and part by part. The reader keeps the
 * version a person last looked at (`rememberSeen`), and marks what changed since (`deckChanges`):
 * an agent asked to change a part writes the deck again, often all of it.
 */
export interface DeckSeen {
  slides: string[]
  parts: string[][]
  notes: string[]
}

/** What changed since a deck was seen: slides, the parts of each changed slide, and notes, by index from 0. */
export interface DeckChanges {
  slides: ReadonlySet<number>
  parts: ReadonlyMap<number, ReadonlySet<number>>
  notes: ReadonlySet<number>
}

/** The fingerprints of a deck: its numbering (`id`, `order`) left out, as a script that writes it again renumbers it. */
export function deckSeen(deck: ParsedDeck): DeckSeen {
  const parts = deck.slides.map((slide) => (slide.elements ?? []).map((element) => fingerprint(element)))
  const notes = deck.slides.map((slide) => fingerprint(slide.note ?? ''))
  const slides = deck.slides.map((slide, index) => fingerprint({ fill: slide.fill, layout: (slide.layoutElements ?? []).map(fingerprint), parts: parts[index], notes: notes[index] }))
  return { slides, parts, notes }
}

/**
 * What changed from `before` to `after`, or `null` when there is nothing to tell it from. A slide
 * found anywhere in `before` is not changed, only moved. A changed slide's parts are told from the
 * slide at its place before; a slide that is new there has none told, as all of it is new.
 */
export function deckChanges(before: DeckSeen | null | undefined, after: DeckSeen): DeckChanges | null {
  if (!before) return null
  const known = new Set(before.slides)
  const slides = new Set<number>()
  const parts = new Map<number, Set<number>>()
  const notes = new Set<number>()
  after.slides.forEach((slide, index) => {
    if (known.has(slide)) return
    slides.add(index)
    const was = before.parts[index]
    if (!was) return
    const kept = new Set(was)
    const changed = new Set(after.parts[index].flatMap((part, at) => (kept.has(part) ? [] : [at])))
    if (changed.size) parts.set(index, changed)
    if (before.notes[index] !== after.notes[index]) notes.add(index)
  })
  return { slides, parts, notes }
}

const SEEN_KEY = 'loomwatch.decksSeen'
/** How many decks' last-seen versions are kept, the latest looked at first. */
const SEEN_MOST = 40

type SeenStore = Array<{ path: string; seen: DeckSeen }>

function store(): SeenStore {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is SeenStore[number] => typeof entry?.path === 'string' && Array.isArray(entry?.seen?.slides)) : []
  } catch {
    return []
  }
}

/** The version of the deck at `path` this browser last showed, if it showed one. */
export function seenBefore(path: string): DeckSeen | null {
  return store().find((entry) => entry.path === path)?.seen ?? null
}

/** Keeps `seen` as the version of the deck at `path` last shown. */
export function rememberSeen(path: string, seen: DeckSeen): void {
  try {
    const kept = [{ path, seen }, ...store().filter((entry) => entry.path !== path)].slice(0, SEEN_MOST)
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(kept))
  } catch {
    // Without storage, nothing is marked as changed the next time: never wrongly.
  }
}

/** A short fingerprint of a value as JSON, its numbering left out (FNV-1a, 52 bits as hex). */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (key, inner: unknown) => (key === 'id' || key === 'order' ? undefined : inner)) ?? ''
  let low = 0x811c9dc5
  let high = 0x1505
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    low = Math.imul(low ^ code, 0x01000193) >>> 0
    high = Math.imul(high ^ code, 0x5bd1e995) >>> 0
  }
  return `${(high & 0xfffff).toString(16)}${low.toString(16).padStart(8, '0')}`
}
