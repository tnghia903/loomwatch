import type { FileToRead } from '../files/reader'

/**
 * The pane beside the team chat (ADR 0051, ADR 0077): the record of the piece of work on screen
 * (Details), and everything it came to, each a tab of its own — the answer itself when it is long
 * enough to be a document, then the files its answer names that LoomWatch reads. The chat keeps the
 * answer short (a card, for a document); what the work made is read here.
 */
export type PaneTab = 'details' | 'answer' | `file:${string}`

export const fileTab = (path: string): PaneTab => `file:${path}`

export interface MadeTab {
  tab: PaneTab
  /** What the tab says: the file's name, or the name of the agent whose answer it is. */
  label: string
  /** Said on hover: the file's full path, or the answer's own title. */
  hint: string
  /** The file it reads; `null` for the answer. */
  file: FileToRead | null
  /** The agent whose answer it is, drawn by its figure as in the chat; none for the team's. */
  by?: string
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
 * The tabs after Details, in order: the answer of the piece on screen when it is a document, named
 * by who gave it so it never reads as a file, then the files it made, minus what you closed. Files
 * kept open (`kept`, in the order they were read) come once each: one of the piece on screen with
 * its files, there before they are found, so the row doesn't swap as they load; one from other work
 * last, so following newer work or reading another piece's file leaves it where it is.
 */
export function madeTabs({ runId, files, answer, kept, closed }: {
  runId: string | null
  files: readonly { file: FileToRead; label: string; kind?: string; lead?: boolean }[]
  answer: { by: string | null; name: string; title: string } | null
  kept: readonly { file: FileToRead; label: string; kind?: string }[]
  closed: ReadonlySet<string>
}): MadeTab[] {
  const open = (tab: PaneTab) => !closed.has(closedKey(runId, tab))
  const tabs: MadeTab[] = answer && open('answer') ? [{ tab: 'answer', label: answer.name, hint: answer.title, file: null, lead: true, ...(answer.by ? { by: answer.by } : {}) }] : []
  const listed = (path: string) => tabs.some((made) => made.file?.path === path)
  for (const { file, label, kind, lead } of files) {
    const tab = fileTab(file.path)
    if (open(tab)) tabs.push({ tab, label, hint: file.path, file, kind, lead })
  }
  for (const { file, label, kind } of kept) {
    const tab = fileTab(file.path)
    if (file.runId === runId && open(tab) && !listed(file.path)) tabs.push({ tab, label, hint: file.path, file, kind })
  }
  for (const { file, label, kind } of kept) {
    if (file.runId !== runId && !listed(file.path)) tabs.push({ tab: fileTab(file.path), label, hint: file.path, file, kind, kept: true })
  }
  return tabs
}

/** A tab's element id, by its place: a path can hold spaces, which `aria-labelledby` splits on. */
export function paneTabId(tabs: readonly MadeTab[], tab: PaneTab): string {
  const at = tabs.findIndex((made) => made.tab === tab)
  return at < 0 ? 'tc-pane-details' : `tc-pane-made-${at}`
}

/**
 * The tab on screen: the one you chose while it is there; else, following the newest work, what it
 * came to once it is done (`done`: finished well) — a file it made before its answer about it —
 * while work in progress shows its record.
 */
export function shownPaneTab(chosen: PaneTab | null, tabs: readonly MadeTab[], following: boolean, done: boolean): PaneTab {
  if (chosen === 'details' || (chosen && tabs.some((made) => made.tab === chosen))) return chosen
  if (!following || !done) return 'details'
  return (tabs.find((made) => made.lead && made.file) ?? tabs.find((made) => made.lead))?.tab ?? 'details'
}

/** Where closing `closing` leaves you, as a browser does: the tab after it, else before it, else Details. */
export function afterClosing(tabs: readonly MadeTab[], closing: PaneTab): PaneTab {
  const at = tabs.findIndex((made) => made.tab === closing)
  if (at < 0) return 'details'
  return tabs[at + 1]?.tab ?? (at > 0 ? tabs[at - 1].tab : 'details')
}
