// The Mac app's side of the island (crates/loomwatch-app/src/island.rs, ADR 0083): what it tells
// the page, and what the page asks of it. In a browser, without the app, nothing arrives and
// nothing is sent, and links open in a new tab.

/** What the app tells the page. */
export type FromApp =
  | { kind: 'place'; notch: { width: number; height: number } | null; menuBar: number }
  /** The pointer is on one of the island's areas, as the page reported them (the island first,
      then what dropped out of it), or on none. WebKit follows the pointer only in a key window,
      and the island's panel never becomes one, so the app says. */
  | { kind: 'pointer'; over: boolean; area: number | null }
  | { kind: 'away'; away: boolean }
  | { kind: 'fullScreen'; on: boolean }
  | { kind: 'clickOutside' }

export interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** What the page asks of the app. */
export type ToApp =
  | { kind: 'ready' }
  | { kind: 'areas'; rects: Area[] }
  | { kind: 'open'; link: string }
  | { kind: 'menu'; x: number; y: number }

declare global {
  interface Window {
    loomwatchIsland?: { receive(message: FromApp): void }
    webkit?: { messageHandlers?: { island?: { postMessage(body: string): void } } }
  }
}

/** The page runs in the Mac app's panel at the notch. */
export function inApp(): boolean {
  return Boolean(window.webkit?.messageHandlers?.island)
}

export function tellApp(message: ToApp): void {
  window.webkit?.messageHandlers?.island?.postMessage(JSON.stringify(message))
}

/** Hear the app; the returned function stops listening. */
export function listen(receive: (message: FromApp) => void): () => void {
  const listener = { receive }
  window.loomwatchIsland = listener
  return () => {
    if (window.loomwatchIsland === listener) delete window.loomwatchIsland
  }
}

/** Open an address inside `LoomWatch`: the Mac app opens it in the browser. */
export function openInLoomWatch(link: string): void {
  if (inApp()) tellApp({ kind: 'open', link })
  else window.open(link, '_blank', 'noopener')
}
