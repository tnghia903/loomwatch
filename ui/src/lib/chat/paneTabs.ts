import type { FileToRead } from '../files/reader'

/**
 * The pane beside the team chat (ADR 0051, ADR 0077): the record of the piece of work on screen
 * (Details), and everything it made, each a tab of its own — the files its answer names that
 * LoomWatch reads, then the answer itself when it is long enough to be a document. The chat keeps
 * the answer short (a card, for a document); what the work made is read here.
 */
export type PaneTab = 'details' | 'answer' | `file:${string}`

export const fileTab = (path: string): PaneTab => `file:${path}`

export interface MadeTab {
  tab: PaneTab
  /** What the tab says: the file's name, or the document's own title. */
  label: string
  /** Said on hover: the file's full path, or whose answer it is. */
  hint: string
  /** The file it reads; `null` for the answer. */
  file: FileToRead | null
  /** The daemon's kind for a file (`web`, `spreadsheet`…), for its icon. */
  kind?: string
  /**
   * What the work came to, worth opening on by itself: a page, document, sheet or picture it
   * wrote, or its long answer. Code, and files it only read or named, wait for you.
   */
  lead?: boolean
  /** Kept open from other work, not made by the piece on screen. */
  kept?: boolean
}

/** A tab you closed stays closed for that piece of work, until you open it again. */
export const closedKey = (runId: string | null, tab: PaneTab): string => `${runId ?? ''}\n${tab}`

/**
 * The tabs after Details, in order: the files the piece on screen made, then its answer when it is a
 * document, minus what you closed. A file kept open from other work (`kept`) comes last, so
 * following newer work leaves it where it is.
 */
export function madeTabs({ runId, files, answer, kept, closed }: {
  runId: string | null
  files: readonly { file: FileToRead; label: string; kind?: string; lead?: boolean }[]
  answer: { title: string; hint: string } | null
  kept: { file: FileToRead; label: string } | null
  closed: ReadonlySet<string>
}): MadeTab[] {
  const open = (tab: PaneTab) => !closed.has(closedKey(runId, tab))
  const tabs: MadeTab[] = files
    .map(({ file, label, kind, lead }) => ({ tab: fileTab(file.path), label, hint: file.path, file, kind, lead }))
    .filter(({ tab }) => open(tab))
  if (answer && open('answer')) tabs.push({ tab: 'answer', label: answer.title, hint: answer.hint, file: null, lead: true })
  if (kept && !tabs.some((made) => made.file?.path === kept.file.path)) tabs.push({ tab: fileTab(kept.file.path), label: kept.label, hint: kept.file.path, file: kept.file, kept: true })
  return tabs
}

/** A tab's element id, by its place: a path can hold spaces, which `aria-labelledby` splits on. */
export function paneTabId(tabs: readonly MadeTab[], tab: PaneTab): string {
  const at = tabs.findIndex((made) => made.tab === tab)
  return at < 0 ? 'tc-pane-details' : `tc-pane-made-${at}`
}

/**
 * The tab on screen: the one you chose while it is there; else, following the newest work, what it
 * came to once it is done (`done`: finished well), while work in progress shows its record.
 */
export function shownPaneTab(chosen: PaneTab | null, tabs: readonly MadeTab[], following: boolean, done: boolean): PaneTab {
  if (chosen === 'details' || (chosen && tabs.some((made) => made.tab === chosen))) return chosen
  return following && done ? tabs.find((made) => made.lead)?.tab ?? 'details' : 'details'
}

/** Where closing `closing` leaves you, as a browser does: the tab after it, else before it, else Details. */
export function afterClosing(tabs: readonly MadeTab[], closing: PaneTab): PaneTab {
  const at = tabs.findIndex((made) => made.tab === closing)
  if (at < 0) return 'details'
  return tabs[at + 1]?.tab ?? (at > 0 ? tabs[at - 1].tab : 'details')
}
