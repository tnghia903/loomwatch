// The Mac app's side of the island (crates/loomwatch-app/src/island.rs, ADR 0083): what it tells
// the page, and what the page asks of it. In a browser, without the app, nothing arrives and
// nothing is sent, and links open in a new tab.

/** What the app tells the page. */
export type FromApp =
  /** Where the panel is: around a notch, the camera's or one drawn in the menu bar of a screen
      without one (`drawn`, decision 12), or with none, under a menu bar `menuBar` tall. */
  | { kind: 'place'; notch: { width: number; height: number } | null; menuBar: number; drawn?: boolean }
  /** The pointer is on one of the island's areas, as the page reported them (the island first,
      then what dropped out of it), or on none. WebKit follows the pointer only in a key window,
      and the island's panel never becomes one, so the app says. */
  | { kind: 'pointer'; over: boolean; area: number | null }
  | { kind: 'away'; away: boolean }
  | { kind: 'fullScreen'; on: boolean }
  | { kind: 'clickOutside' }
  /** ⌃⌥Space, or Message in the app's menu: open the box to write to an agent, with the keyboard
      the app has given the panel; or, pressed again while it is open, put it away. */
  | { kind: 'compose' }
  /** Something (a file, a picture, text, a link) is being dragged near the island, or no longer
      is: the island opens as a slot to take it. */
  | { kind: 'drag'; near: boolean }
  /** This screen's panel is the live one, on the screen the pointer is on: the box opens here, and
      what its agent does drops out here. Live until the app says. */
  | { kind: 'live'; on: boolean }
  /** This island pops the teams' news out: the one at a notch, wherever the pointer is. A panel
      without a notch never does. On until the app says. */
  | { kind: 'news'; on: boolean }
  /** Results looked at on another screen's island, by run: they leave this one too. */
  | { kind: 'seen'; runs: string[] }
  /** Files dropped on the island that the app took itself, files another app writes only once
      dropped, as Mail does with a message: the page's file picker asks for them, and the app
      answers it with them (`pickFiles`). */
  | { kind: 'dropped' }
  /** ⌃⌥Space is held: the app listens, with the box open, until it is let go (`on: false`). */
  | { kind: 'listen'; on: boolean }
  /** Every word heard while it was held, so far; `done` once the last of them are in. */
  | { kind: 'heard'; text: string; done: boolean }
  /** How loud it hears, from 0 to 1, a dozen times a second while it listens. */
  | { kind: 'level'; level: number }
  /** It could not listen: the microphone or speech recognition is turned off for LoomWatch, macOS
      has just asked for them (`asked`), this Mac can't turn speech into words now, or has no
      microphone; or it stopped, still held, having listened as long as it may (`longest`). */
  | { kind: 'cantListen'; why: CantListen }

/** Why holding ⌃⌥Space did not listen, or stopped, as the app says. */
export type CantListen = 'microphone' | 'speech' | 'asked' | 'unavailable' | 'noMicrophone' | 'longest'

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
  /** Take the keyboard, for a message being written to an agent, or give it back to whatever had
      it. The panel takes it only while one is written. */
  | { kind: 'keyboard'; on: boolean }
  /** The agent the box opens with, by name, so ⌃⌥Space and Message in the app's menu have a box to
      open; `null` with no agent in My agents. */
  | { kind: 'agent'; name: string | null }
  /** Put an answer on the clipboard, Copy on it: `text` for apps that take plain text, and `html`,
      when there is one, formatted for apps that take it. */
  | { kind: 'copy'; text: string; html: string | null }
  /** Results looked at here, by run: they leave the other screens' islands too. */
  | { kind: 'seen'; runs: string[] }
  /** Open System Settings where the microphone, or speech recognition, is turned on for LoomWatch. */
  | { kind: 'settings'; pane: 'microphone' | 'speech' }

declare global {
  interface Window {
    loomwatchIsland?: { receive(message: FromApp): void }
    webkit?: { messageHandlers?: { island?: { postMessage(body: string): void } } }
  }
}

/** The shortcut that opens the box to an agent from any app (`island::SHORTCUT_KEY`). */
export const PINNED_SHORTCUT = '⌃⌥Space'
/** The same, in words, for people who don't read ⌃ and ⌥. */
export const PINNED_SHORTCUT_WORDS = 'Control-Option-Space'

/** The page runs in one of the Mac app's panels, at the notch or at the top of another screen. */
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
