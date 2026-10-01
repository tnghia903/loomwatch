import { useEffect, useState } from 'react'

import { lookupFile, openFile, type FileLookup } from './client'

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
