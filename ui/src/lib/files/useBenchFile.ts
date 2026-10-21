import { useCallback, useMemo, useState } from 'react'

import type { ReplyTo } from '../chat/client'
import type { AskedPassage } from './passage'
import type { FileToRead } from './reader'

/**
 * A file one of the agent's answers names, read over the bench as a long answer is (ADR 0077): the
 * chat opens it, the reader asks about a part of it in the chat, and the chat says which parts were
 * asked about. Kept by the screen that holds both.
 */
export function useBenchFile() {
  const [reading, setReading] = useState<FileToRead | null>(null)
  const [ask, setAsk] = useState<{ reply: ReplyTo; words?: string; at: number } | null>(null)
  const [passages, setPassages] = useState<{ asked: AskedPassage[]; asking: string | null }>({ asked: [], asking: null })
  const [reveal, setReveal] = useState<{ runId: string; id: string; at: number } | null>(null)
  const onPassages = useCallback((asked: AskedPassage[], asking: string | null) => setPassages({ asked, asking }), [])
  const chat = useMemo(() => ({ open: setReading, ask, onPassages, reveal }), [ask, onPassages, reveal])
  return {
    reading,
    close: useCallback(() => setReading(null), []),
    chat,
    passages,
    // An agent's own chat has one agent to ask: the one the part is from.
    askInChat: useCallback((reply: ReplyTo, words: string | undefined) => setAsk({ reply, words, at: Date.now() }), []),
    showAsked: useCallback((passage: AskedPassage) => {
      if (passage.runId) setReveal({ runId: passage.runId, id: `answer:${passage.runId}`, at: Date.now() })
    }, []),
  }
}

export type BenchFile = ReturnType<typeof useBenchFile>
