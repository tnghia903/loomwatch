import { useEffect, useRef, useState } from 'react'

import { deckChanges, deckSeen, rememberSeen, seenBefore, type DeckSeen } from './deckSeen'
import { rawFileUrl } from './reader'
import { DARK_LOOK, lookOf, PAPER_LOOK, type PageLook } from './pageLook'

/** The kinds of file drawn inside LoomWatch from their bytes: a PowerPoint deck and a Word document. */
export type DrawnKind = 'slides' | 'document'

export interface DrawOptions {
  /** The reader's colours, for what lies around the paper. */
  look?: PageLook
  /** A picture of the figure of the agent whose file it is, as data, shown on a slide that changed. */
  face?: string | null
  /** The deck as it was last seen, for what changed since to be marked. */
  seen?: DeckSeen | null
}

/** The page, and for a deck how it was seen now, for the next draw to tell what changed. */
export interface Drawn {
  html: string
  seen: DeckSeen | null
}

/**
 * A slide deck or a Word document drawn as a web page, from its bytes (ADR 0091): LoomWatch draws
 * it itself, so nothing else is needed on the computer, and it opens at once. The drawing code is
 * loaded only when such a file is first opened.
 */
export async function drawnPage(path: string, kind: DrawnKind, name: string, version: string | null, options: DrawOptions = {}, signal?: AbortSignal): Promise<Drawn> {
  const response = await fetch(`${rawFileUrl(path)}&v=${encodeURIComponent(version ?? '')}`, { signal })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
  }
  const bytes = await response.arrayBuffer()
  if (kind === 'slides') {
    const [{ parse }, { withInheritedStyles }, { slidesPage }] = await Promise.all([import('pptxtojson'), import('./deckStyles'), import('./slidesPage')])
    // Its pictures are kept in the page as data: the reader's frame can fetch nothing.
    const deck = await parse(await withInheritedStyles(bytes), { imageMode: 'base64', videoMode: 'none', audioMode: 'none' })
    const seen = deckSeen(deck)
    return { html: slidesPage(deck, name, options.look, { changes: deckChanges(options.seen, seen), face: options.face ?? null }), seen }
  }
  const { documentPage } = await import('./documentPage')
  return { html: await documentPage(bytes, name, options.look), seen: null }
}

/**
 * The reader's ground and words in `theme`, the one shown now, for the paper to lie on (`PageLook`):
 * read from the app's own styles, as the frame the page is drawn in can't read them.
 */
export function readerLook(theme: 'dark' | 'light'): PageLook {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string) => styles.getPropertyValue(name).trim()
  return lookOf({ ground: token('--color-ground'), ink: token('--color-ink'), label: token('--color-ink-2'), accent: token('--color-accent') }, theme === 'dark' ? DARK_LOOK : PAPER_LOOK)
}

export type DrawnState = { html: string; error: null } | { html: null; error: string } | null

/**
 * The page a deck or a Word document is drawn as, drawn again when the file changes (`version`, its
 * last change as the reader saw it), the theme does (`look`) or the agent's `face` comes in. `null`
 * while it is first drawn, or for no file.
 *
 * A deck shows what changed since it was last seen: on opening, since the version this browser last
 * showed (`seenBefore`); once it changes while open, since the version on screen before. Drawn again
 * for the theme or the face, it keeps what it was told from.
 */
export function useDrawnPage(path: string | null, kind: DrawnKind | null, name: string, version: string | null, look: PageLook, face: string | null = null): DrawnState {
  const [state, setState] = useState<{ key: string; path: string; value: DrawnState }>({ key: '', path: '', value: null })
  const compared = useRef<{ path: string; version: string | null; against: DeckSeen | null; shown: DeckSeen | null } | null>(null)
  // Drawn again in the reader's colours when the theme changes.
  const key = path && kind ? `${kind}:${path}:${version ?? ''}:${look.ground}:${look.ink}:${look.label}:${look.accent}:${face ?? ''}` : ''
  useEffect(() => {
    if (!path || !kind) return
    const before = compared.current
    const against = before?.path !== path ? seenBefore(path) : before.version === version ? before.against : before.shown
    const controller = new AbortController()
    void drawnPage(path, kind, name, version, { look, face, seen: against }, controller.signal).then(
      (drawn) => {
        if (controller.signal.aborted) return
        compared.current = { path, version, against, shown: drawn.seen }
        if (drawn.seen) rememberSeen(path, drawn.seen)
        setState({ key, path, value: { html: drawn.html, error: null } })
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setState({ key, path, value: { html: null, error: caught instanceof Error ? caught.message : String(caught) } })
      },
    )
    return () => controller.abort()
    // `key` holds the look's colours: a new object of the same colours draws nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, kind, name, version])
  // The file as it was stays on screen while it is drawn again.
  return key && (state.key === key || state.path === path) ? state.value : null
}
