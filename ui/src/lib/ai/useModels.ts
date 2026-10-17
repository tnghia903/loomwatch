import { useEffect, useState } from 'react'

import { type Catalog, fetchModels } from './client'

// One fetch for the whole app: every picker on the canvas reads the same list, and the daemon
// keeps it an hour anyway. A failed fetch is forgotten, so the next picker that opens tries again.
let shared: Promise<Catalog> | null = null
/** The list once it has arrived, so a picker opened later shows it straight away. */
let known: Catalog | null = null

function load(): Promise<Catalog> {
  shared ??= fetchModels().then(
    (catalog) => { known = catalog; return catalog },
    (error: unknown) => { shared = null; throw error },
  )
  return shared
}

/** The model list, once it has arrived. */
export function useModels(): { catalog: Catalog | null; error: string } {
  const [catalog, setCatalog] = useState<Catalog | null>(known)
  const [error, setError] = useState('')
  useEffect(() => {
    if (known) return
    let active = true
    load()
      .then((value) => { if (active) setCatalog(value) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'The model list isn’t available.') })
    return () => { active = false }
  }, [])
  return { catalog, error }
}

/** For tests: forget the list fetched so far. */
export function forgetModels() {
  shared = null
  known = null
}
