import { useEffect, useState } from 'react'

import { rawFileUrl } from './reader'

/** The kinds of file drawn inside LoomWatch from their bytes: a PowerPoint deck and a Word document. */
export type DrawnKind = 'slides' | 'document'

/**
 * A slide deck or a Word document drawn as a web page, from its bytes (ADR 0091): LoomWatch draws
 * it itself, so nothing else is needed on the computer, and it opens at once. The drawing code is
 * loaded only when such a file is first opened.
 */
export async function drawnPage(path: string, kind: DrawnKind, name: string, version: string | null, signal?: AbortSignal): Promise<string> {
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
    return slidesPage(deck, name)
  }
  const { documentPage } = await import('./documentPage')
  return documentPage(bytes, name)
}

export type DrawnState = { html: string; error: null } | { html: null; error: string } | null

/**
 * The page a deck or a Word document is drawn as, drawn again when the file changes (`version`, its
 * last change as the reader saw it). `null` while it is first drawn, or for no file.
 */
export function useDrawnPage(path: string | null, kind: DrawnKind | null, name: string, version: string | null): DrawnState {
  const [state, setState] = useState<{ key: string; path: string; value: DrawnState }>({ key: '', path: '', value: null })
  const key = path && kind ? `${kind}:${path}:${version ?? ''}` : ''
  useEffect(() => {
    if (!path || !kind) return
    const controller = new AbortController()
    void drawnPage(path, kind, name, version, controller.signal).then(
      (html) => setState({ key, path, value: { html, error: null } }),
      (caught: unknown) => {
        if (!controller.signal.aborted) setState({ key, path, value: { html: null, error: caught instanceof Error ? caught.message : String(caught) } })
      },
    )
    return () => controller.abort()
  }, [key, path, kind, name, version])
  // The file as it was stays on screen while it is drawn again.
  return key && (state.key === key || state.path === path) ? state.value : null
}
