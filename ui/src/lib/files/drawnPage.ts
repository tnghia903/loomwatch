import { useEffect, useRef, useState } from 'react'

import { deckChanges, deckSeen, rememberSeen, seenBefore, type DeckSeen } from './deckSeen'
import { rawFileUrl, rawVersion } from './reader'
import { DARK_LOOK, lookOf, PAPER_LOOK, type PageLook } from './pageLook'

/** The kinds of file drawn inside LoomWatch from their bytes: a PowerPoint deck and a Word document. */
export type DrawnKind = 'slides' | 'document'

export interface DrawOptions {
  /** The reader's colours, for what lies around the paper. */
  look?: PageLook
  /** Where the picture of the figure of the agent whose file it is is: shown on a slide that changed. */
  faceUrl?: string | null
  /** The deck as it was last seen, for what changed since to be marked. */
  seen?: DeckSeen | null
  /**
   * Drawn to be typed into (ADR 0107): a deck's notes as their paragraphs, and each paragraph of
   * its boxes of words, or a Word document's paragraphs, typed into where they are.
   */
  editing?: boolean
  /**
   * The deck on screen before, and what it was told from, for a version that is your own change
   * (`rememberOwnChange`): what you changed is not marked, and what was marked stays marked.
   */
  before?: { against: DeckSeen | null; shown: DeckSeen | null } | null
}

/**
 * The page; the bytes it was drawn from and their version, which a change typed into it is made on
 * and names (ADR 0107); and for a deck how it was seen now and what it was told from, for the next
 * draw to tell what changed. `own`: the version is a change you made here (`rememberOwnChange`).
 */
export interface Drawn {
  html: string
  seen: DeckSeen | null
  bytes: Uint8Array
  version: string | null
  from: DeckSeen | null
  own: OwnChange | null
}

/** A version you made here: `shown` when the page on screen shows it already, as one typed into it does. */
export interface OwnChange { shown: boolean }

/** The versions of each file written here, newest last: a few, for a change that comes back from the disk. */
const ownChanges = new Map<string, Map<string, OwnChange>>()
const OWN_KEPT = 20

/**
 * Says that `version` of the file at `path` is a change you made here (ADR 0107), so that drawing it
 * marks nothing you changed as "changed since you last looked". `shown`: the page on screen shows it
 * already (words typed into it, written back), so it is not drawn again for it; `false` for one it
 * doesn't show yet, such as an Undo. Call it with the version the write answered.
 */
export function rememberOwnChange(path: string, version: string, shown = true): void {
  const kept = ownChanges.get(path) ?? new Map<string, OwnChange>()
  kept.delete(version)
  kept.set(version, { shown })
  while (kept.size > OWN_KEPT) kept.delete(kept.keys().next().value!)
  ownChanges.set(path, kept)
}

/** Whether `version` of `path` is a change you made here, and how. */
export function ownChange(path: string, version: string | null): OwnChange | null {
  return version ? ownChanges.get(path)?.get(version) ?? null : null
}

/**
 * What a deck is told from once you changed it yourself: what it was told from, with each part you
 * changed taken as seen where it wasn't marked before, so your change is never marked and what the
 * agent changed stays marked. `null` when nothing was marked before.
 */
export function ownBase(against: DeckSeen | null, shown: DeckSeen | null, now: DeckSeen): DeckSeen | null {
  if (!against || !shown) return against
  const known = new Set(against.slides)
  const slides = [...against.slides]
  const parts = against.parts.map((list) => [...list])
  const notes = [...against.notes]
  now.slides.forEach((slide, index) => {
    if (slide === shown.slides[index]) return
    // A slide that wasn't marked: as you left it, it is seen.
    if (known.has(shown.slides[index])) { slides.push(slide); return }
    // A slide marked for the agent's change: your parts and notes on it as seen, the agent's as they were.
    const was = new Set(against.parts[index] ?? [])
    const told = parts[index]
    if (told) (now.parts[index] ?? []).forEach((part, at) => { if (part !== shown.parts[index]?.[at] && was.has(shown.parts[index]?.[at] ?? '')) told.push(part) })
    if (now.notes[index] !== shown.notes[index] && against.notes[index] === shown.notes[index]) notes[index] = now.notes[index]
  })
  return { slides, parts, notes }
}

/**
 * A slide deck or a Word document drawn as a web page, from its bytes (ADR 0091): LoomWatch draws
 * it itself, so nothing else is needed on the computer, and it opens at once. The drawing code is
 * loaded only when such a file is first opened.
 */
export async function drawnPage(path: string, kind: DrawnKind, name: string, version: string | null, options: DrawOptions = {}, signal?: AbortSignal): Promise<Drawn> {
  // The face is taken in with the deck, so the page is drawn once, with it.
  const face = kind === 'slides' && options.faceUrl ? pictureData(options.faceUrl, signal) : Promise.resolve(null)
  const response = await fetch(`${rawFileUrl(path)}&v=${encodeURIComponent(version ?? '')}`, { signal })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
  }
  const fileVersion = rawVersion(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const own = ownChange(path, fileVersion)
  if (kind === 'slides') {
    const [{ parse }, { withInheritedStyles }, { slidesPage }] = await Promise.all([import('pptxtojson'), import('./deckStyles'), import('./slidesPage')])
    // Its pictures are kept in the page as data: the reader's frame can fetch nothing.
    const deck = await parse(await withInheritedStyles(bytes.buffer), { imageMode: 'base64', videoMode: 'none', audioMode: 'none' })
    const seen = deckSeen(deck)
    // Your own change is told from as seen; opened anew on it, all of it is, as you had it in front of you.
    const from = !own ? options.seen ?? null : options.before ? ownBase(options.before.against, options.before.shown, seen) : seen
    const marks = { changes: deckChanges(from, seen), face: await face }
    if (!options.editing) return { html: slidesPage(deck, name, options.look, marks), seen, bytes, version: fileVersion, from, own }
    const [{ deckNotes }, { deckShapes }, { editableDeck }] = await Promise.all([import('./deckNotes'), import('./officeEdits'), import('./editableParts')])
    const [notes, shapes] = await Promise.all([deckNotes(bytes), deckShapes(bytes)])
    const html = editableDeck(slidesPage(deck, name, options.look, marks, { notes }), deck, shapes, lookOf(options.look, PAPER_LOOK))
    return { html, seen, bytes, version: fileVersion, from, own }
  }
  const { documentPage } = await import('./documentPage')
  return { html: await documentPage(bytes, name, options.look, { editing: options.editing }), seen: null, bytes, version: fileVersion, from: null, own }
}

/** A picture as data, for a page that can fetch nothing; `null` for anything that isn't a picture, or isn't there. */
async function pictureData(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { signal })
    const type = response.headers.get('content-type')?.split(';')[0].trim() ?? ''
    if (!response.ok || !/^image\/[a-z0-9.+-]+$/i.test(type)) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    return `data:${type};base64,${btoa(binary)}`
  } catch {
    return null
  }
}

/**
 * The reader's ground and words in `theme`, the one shown now, for the paper to lie on (`PageLook`):
 * read from the app's own styles, as the frame the page is drawn in can't read them.
 */
export function readerLook(theme: 'dark' | 'light'): PageLook {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string) => styles.getPropertyValue(name).trim()
  return lookOf({ ground: token('--color-ground'), ink: token('--color-ink'), label: token('--color-ink-2'), accent: token('--color-accent'), accentDim: token('--color-accent-dim'), paperAccent: token('--color-paper-gold') }, theme === 'dark' ? DARK_LOOK : PAPER_LOOK)
}

/**
 * A deck or a Word document as drawn: the page, and the bytes it was drawn from and their version
 * (`Drawn`), which a change typed into it is made on and names; or why it couldn't be drawn.
 */
export type DrawnState = { html: string; error: null; bytes: Uint8Array; version: string | null } | { html: null; error: string } | null

/**
 * The page a deck or a Word document is drawn as, drawn again when the file changes (`version`, its
 * last change as the reader saw it) or the theme does (`look`). `null` while it is first drawn, or
 * for no file. `faceUrl` is where the picture of the agent whose file it is is. `editing`: drawn to
 * be typed into (ADR 0107).
 *
 * A deck shows what changed since it was last seen: on opening, since the version this browser last
 * showed (`seenBefore`); once it changes while open, since the version on screen before. Drawn again
 * for the theme or the face, it keeps what it was told from. A version that is your own change
 * (`rememberOwnChange`) marks nothing you changed, and one the page shows already, as words typed
 * into it do, leaves the page on screen as it is (the slide shown, the part typed in next) with the
 * new bytes and version under it.
 */
export function useDrawnPage(path: string | null, kind: DrawnKind | null, name: string, version: string | null, look: PageLook, faceUrl: string | null = null, editing = false): DrawnState {
  const [state, setState] = useState<{ key: string; path: string; drawing: string; value: DrawnState }>({ key: '', path: '', drawing: '', value: null })
  const compared = useRef<{ path: string; version: string | null; against: DeckSeen | null; shown: DeckSeen | null } | null>(null)
  // Drawn again in the reader's colours when the theme changes; what is drawn, but for the version.
  const drawing = path && kind ? `${kind}:${path}:${look.ground}:${look.ink}:${look.label}:${look.accent}:${look.paperAccent}:${faceUrl ?? ''}:${editing ? 'editing' : ''}` : ''
  const key = drawing ? `${drawing}:${version ?? ''}` : ''
  useEffect(() => {
    if (!path || !kind) return
    const before = compared.current
    const opened = before?.path !== path
    const against = opened ? seenBefore(path) : before.version === version ? before.against : before.shown
    const controller = new AbortController()
    void drawnPage(path, kind, name, version, { look, faceUrl, seen: against, editing, before: opened ? null : { against: before.against, shown: before.shown } }, controller.signal).then(
      (drawn) => {
        if (controller.signal.aborted) return
        compared.current = { path, version, against: drawn.from, shown: drawn.seen }
        if (drawn.seen) rememberSeen(path, drawn.seen)
        setState((was) => {
          // Your own change the page shows already: the page stays, with the file's new bytes under it.
          const kept = drawn.own?.shown && was.drawing === drawing && was.value?.html ? was.value.html : null
          return { key, path, drawing, value: { html: kept ?? drawn.html, error: null, bytes: drawn.bytes, version: drawn.version } }
        })
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setState({ key, path, drawing, value: { html: null, error: caught instanceof Error ? caught.message : String(caught) } })
      },
    )
    return () => controller.abort()
    // `key` holds the look's colours: a new object of the same colours draws nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, kind, name, version])
  // The file as it was stays on screen while it is drawn again.
  return key && (state.key === key || state.path === path) ? state.value : null
}
