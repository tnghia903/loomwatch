import { useEffect, useMemo, useState } from 'react'

import type { RunEvent } from '../watch/events'
import { placedSoFar, shownSoFar } from './place'
import type { KeptWidget } from './types'

/** An answer's words and the widgets in it, and whether it is still being written. */
export interface InAnswer {
  words: string
  widgets: readonly KeptWidget[]
  /** Still being written: the widgets are drawn as they will be, and work once it is done. */
  live: boolean
}

/** How long a finished answer goes on showing the widgets it placed while it was written, until the
    chat brings the ones kept with it. */
const HOLD_MS = 4000

/**
 * The words of an answer and the widgets in it (ADR 0114). While the answer is written, the widgets
 * its agent has shown stand where its words place them, so each appears where it will stay. Once it
 * is done, the widgets kept with it (`kept`; null when the work didn't succeed, so none will come);
 * until the chat brings them, the ones it placed while written stay, so nothing jumps.
 */
export function useAnswerWidgets({ answer, finished, kept, events, responder }: { answer: string; finished: boolean; kept: readonly KeptWidget[] | null; events: readonly RunEvent[]; responder: string | null | undefined }): InAnswer {
  const shown = useMemo(() => (finished ? null : shownSoFar(events, responder)), [finished, events, responder])
  const live = useMemo(() => (shown ? placedSoFar(answer, shown) : null), [shown, answer])
  // The last words written with a widget placed in them, kept from render to render.
  const [held, setHeld] = useState<{ words: string; widgets: KeptWidget[] } | null>(null)
  if (live && live.widgets.length > 0 && live !== held) setHeld(live)
  const waiting = finished && kept !== null && kept.length === 0 && held !== null
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setGaveUp(true), HOLD_MS)
    return () => clearTimeout(timer)
  }, [waiting])
  if (live) return { words: live.words, widgets: live.widgets, live: true }
  if (waiting && !gaveUp && held) return { words: held.words, widgets: held.widgets, live: true }
  return { words: answer, widgets: kept ?? [], live: false }
}
