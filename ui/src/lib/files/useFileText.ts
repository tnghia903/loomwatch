import { useEffect, useState } from 'react'

import { statFile } from './client'
import { readFile, type FileText } from './reader'

/** How often an open file is checked for changes: an agent asked to change it writes it again. */
export const CHECK_EVERY_MS = 3_000

export interface FileTextState {
  /** The file's text, once read. */
  file: FileText | null
  /** Why it can't be read, in the daemon's words. */
  error: string | null
  /** When the file on disk last changed, as the reader last saw it. */
  modifiedAt: string | null
  /** Counts each time the file changed while it was open, so the reader can say so. */
  changes: number
}

const EMPTY: FileTextState = { file: null, error: null, modifiedAt: null, changes: 0 }

/**
 * A file read for the reader (ADR 0077), and read again whenever it changes on disk while it is
 * open — checked every few seconds while the page is in view. `text: false` (a picture, a
 * recording) only watches for changes.
 */
export function useFileText(path: string, text: boolean): FileTextState {
  const [state, setState] = useState<{ path: string; value: FileTextState }>({ path, value: EMPTY })
  const [version, setVersion] = useState<{ path: string; at: string | null; count: number }>({ path, at: null, count: 0 })

  useEffect(() => {
    let current = true
    const check = async () => {
      if (document.hidden) return
      const lookup = await statFile(path).catch(() => null)
      if (!current || lookup?.state !== 'found' || !lookup.facts.exists) return
      const at = lookup.facts.modifiedAt
      setVersion((seen) => (seen.path !== path ? { path, at, count: 0 } : seen.at === null ? { ...seen, at } : seen.at !== at ? { path, at, count: seen.count + 1 } : seen))
    }
    void check()
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS)
    return () => { current = false; window.clearInterval(timer) }
  }, [path])

  const count = version.path === path ? version.count : 0
  useEffect(() => {
    if (!text) return
    const controller = new AbortController()
    void readFile(path, controller.signal).then(
      (file) => setState({ path, value: { file, error: null, modifiedAt: file.modifiedAt, changes: count } }),
      (caught: unknown) => {
        if (controller.signal.aborted) return
        setState({ path, value: { file: null, error: caught instanceof Error ? caught.message : String(caught), modifiedAt: null, changes: count } })
      },
    )
    return () => controller.abort()
  }, [path, text, count])

  if (!text) return { ...EMPTY, modifiedAt: version.path === path ? version.at : null, changes: count }
  return state.path === path ? state.value : EMPTY
}
