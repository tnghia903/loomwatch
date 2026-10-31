import { useEffect, useState } from 'react'

import { rawFileUrl } from './reader'
import { DARK_LOOK, lookOf, PAPER_LOOK, type PageLook } from './pageLook'

/** The kinds of file drawn inside LoomWatch from their bytes: a PowerPoint deck and a Word document. */
export type DrawnKind = 'slides' | 'document'

/**
 * A slide deck or a Word document drawn as a web page, from its bytes (ADR 0091): LoomWatch draws
 * it itself, so nothing else is needed on the computer, and it opens at once. The drawing code is
 * loaded only when such a file is first opened.
 */
export async function drawnPage(path: string, kind: DrawnKind, name: string, version: string | null, look?: PageLook, signal?: AbortSignal): Promise<string> {
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
    return slidesPage(deck, name, look)
  }
  const { documentPage } = await import('./documentPage')
  return documentPage(bytes, name, look)
}

/**
 * The reader's ground and words in `theme`, the one shown now, for the paper to lie on (`PageLook`):
 * read from the app's own styles, as the frame the page is drawn in can't read them.
 */
export function readerLook(theme: 'dark' | 'light'): PageLook {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string) => styles.getPropertyValue(name).trim()
  return lookOf({ ground: token('--color-ground'), ink: token('--color-ink'), label: token('--color-ink-2') }, theme === 'dark' ? DARK_LOOK : PAPER_LOOK)
}

export type DrawnState = { html: string; error: null } | { html: null; error: string } | null

/**
 * The page a deck or a Word document is drawn as, drawn again when the file changes (`version`, its
 * last change as the reader saw it) or the theme does (`look`). `null` while it is first drawn, or
 * for no file.
 */
export function useDrawnPage(path: string | null, kind: DrawnKind | null, name: string, version: string | null, look: PageLook): DrawnState {
  const [state, setState] = useState<{ key: string; path: string; value: DrawnState }>({ key: '', path: '', value: null })
  // Drawn again in the reader's colours when the theme changes.
  const key = path && kind ? `${kind}:${path}:${version ?? ''}:${look.ground}:${look.ink}:${look.label}` : ''
  useEffect(() => {
    if (!path || !kind) return
    const controller = new AbortController()
    void drawnPage(path, kind, name, version, look, controller.signal).then(
      (html) => setState({ key, path, value: { html, error: null } }),
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
