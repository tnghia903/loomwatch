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
  /** ⌃⌥Space: open the message box to the pinned agent, with the keyboard the app has given the
      panel; or, pressed again while it is open, put it away. */
  | { kind: 'compose' }
  /** Something (a file, a picture, text, a link) is being dragged near the island, or no longer
      is: the island opens as a slot to take it. */
  | { kind: 'drag'; near: boolean }
  /** This screen's island is the live one, on the screen the pointer is on: it opens and drops
      things out. Every other screen's island stays at rest. Live until the app says. */
  | { kind: 'live'; on: boolean }
  /** Results looked at on another screen's island, by run: they leave this one too. */
  | { kind: 'seen'; runs: string[] }
  /** Files dropped on the island that the app took itself, files another app writes only once
      dropped, as Mail does with a message: the page's file picker asks for them, and the app
      answers it with them (`takeDropped`). */
  | { kind: 'dropped' }

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
  /** Take the keyboard, for a message being written to the pinned agent, or give it back to
      whatever had it. The panel takes it only while one is written. */
  | { kind: 'keyboard'; on: boolean }
  /** The agent pinned to the notch, by name, so ⌃⌥Space has a box to open; `null` when none is. */
  | { kind: 'pinned'; name: string | null }
  /** Put an answer on the clipboard, Copy on it: `text` for apps that take plain text, and `html`,
      when there is one, formatted for apps that take it. */
  | { kind: 'copy'; text: string; html: string | null }
  /** Results looked at here, by run: they leave the other screens' islands too. */
  | { kind: 'seen'; runs: string[] }

declare global {
  interface Window {
    loomwatchIsland?: { receive(message: FromApp): void }
    webkit?: { messageHandlers?: { island?: { postMessage(body: string): void } } }
  }
}

/** The shortcut that opens the box to the pinned agent from any app (`island::SHORTCUT_KEY`). */
export const PINNED_SHORTCUT = '⌃⌥Space'
/** The same, in words, for people who don't read ⌃ and ⌥. */
export const PINNED_SHORTCUT_WORDS = 'Control-Option-Space'

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
