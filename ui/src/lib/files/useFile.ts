import { useEffect, useState } from 'react'

import { lookupFile, openFile, type FileFacts, type FileLookup } from './client'

/** What the daemon knows about `path`; `null` while it is being asked. */
export function useFileLookup(path: string): FileLookup | null {
  const [answer, setAnswer] = useState<{ path: string; lookup: FileLookup } | null>(null)
  useEffect(() => {
    let current = true
    void lookupFile(path).then((lookup) => { if (current) setAnswer({ path, lookup }) })
    return () => { current = false }
  }, [path])
  return answer?.path === path ? answer.lookup : null
}

const NONE: ReadonlyArray<{ path: string; facts: FileFacts }> = []

/** The files among `paths` that are on this computer, in their order; `null` while they are asked. */
export function useFilesFound(paths: readonly string[]): ReadonlyArray<{ path: string; facts: FileFacts }> | null {
  const key = paths.join('\n')
  const [answer, setAnswer] = useState<{ key: string; found: Array<{ path: string; facts: FileFacts }> } | null>(null)
  useEffect(() => {
    if (!key) return
    let current = true
    const asked = key.split('\n')
    void Promise.all(asked.map((path) => lookupFile(path))).then((lookups) => {
      if (!current) return
      setAnswer({ key, found: lookups.flatMap((lookup, at) => (lookup.state === 'found' && lookup.facts.exists && !lookup.facts.isDir ? [{ path: asked[at], facts: lookup.facts }] : [])) })
    })
    return () => { current = false }
  }, [key])
  if (!key) return NONE
  return answer?.key === key ? answer.found : null
}

/** Open, show in folder, copy — and one line saying how it went, for a `role=status` region. */
export function useFileActions(path: string) {
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState(false)
  const open = async (reveal = false) => {
    setBusy(true)
    setSaid(reveal ? 'Showing it in its folder…' : 'Opening in its app…')
    try {
      await openFile(path, reveal)
      setSaid(reveal ? 'Shown in its folder' : 'Opened')
    } catch (caught) {
      setSaid(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path)
      setSaid('Path copied')
    } catch {
      setSaid('Copy is unavailable here; the full path is in the tooltip')
    }
  }
  return { said, busy, open, copy }
}
