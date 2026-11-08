import { useCallback, useSyncExternalStore } from 'react'

import type { KeptWidget, WidgetState } from './types'

/**
 * A long answer's widgets, drawn inside it where it is read in full (ADR 0114): the pane beside a
 * team's chat, or over an agent's bench. The chat shows the answer as a card and keeps its widgets
 * (it reads its page every few seconds); the reader draws them from the chat's copy, so a tick made
 * in the reader is still there when it opens again.
 */
export interface DocumentWidgets {
  /** The answer's widgets that stand in the document, each with the line its words placed it before. */
  widgets: readonly KeptWidget[]
  /** The answer is still being written: they are drawn as they will be, and work once it is done. */
  live: boolean
  /** Keep what you made of widget `n`: answers with it as kept. */
  onChange: (n: number, state: WidgetState) => Promise<KeptWidget>
}

/**
 * Whether a long answer's widget stands in the document. Choices stay under the answer's card in the
 * chat: a tap sends your next message, from where you write it, and only the newest answer's can be
 * tapped. Every other widget goes with the words it illustrates.
 */
export function inDocument(kept: KeptWidget): boolean {
  // A suggested skill is about the agent's way of working, not the document: it stays under the
  // answer in the chat.
  return kept.spec.kind !== 'choices' && kept.spec.kind !== 'skill'
}

interface Shown {
  /** What the reader draws now. */
  widgets: DocumentWidgets
  /** What it was made from, so the same widgets told again change nothing. */
  key: string
}

const shown = new Map<string, Shown>()
// The newest way to keep a change for each answer, so a reader drawn before it still keeps one.
const changers = new Map<string, DocumentWidgets['onChange']>()
const listeners = new Set<() => void>()

/** Tell the readers what the answer of `runId` holds now; null once it holds nothing to draw there. */
export function showInDocument(runId: string, widgets: DocumentWidgets | null): void {
  if (!widgets) {
    changers.delete(runId)
    if (shown.delete(runId)) listeners.forEach((listener) => listener())
    return
  }
  changers.set(runId, widgets.onChange)
  const key = JSON.stringify([widgets.widgets, widgets.live])
  if (shown.get(runId)?.key === key) return
  const onChange: DocumentWidgets['onChange'] = (n, state) => (changers.get(runId) ?? widgets.onChange)(n, state)
  shown.set(runId, { key, widgets: { widgets: widgets.widgets, live: widgets.live, onChange } })
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The widgets to draw in the answer of `runId` where it is read in full; null for none. */
export function useDocumentWidgets(runId: string | null | undefined): DocumentWidgets | null {
  const read = useCallback(() => (runId ? shown.get(runId)?.widgets ?? null : null), [runId])
  return useSyncExternalStore(subscribe, read, read)
}
