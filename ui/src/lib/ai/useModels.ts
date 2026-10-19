import { useEffect, useState } from 'react'

import { type Catalog, fetchModels } from './client'

// One fetch for the whole app: every picker on the canvas reads the same list, and the daemon
// keeps it an hour anyway. A failed fetch is forgotten, so the next picker that opens tries again.
// Connecting or removing a source refreshes it, so the picker shows that source's models at once.
let shared: Promise<Catalog> | null = null
/** The list once it has arrived, so a picker opened later shows it straight away. */
let known: Catalog | null = null
const listeners = new Set<(catalog: Catalog) => void>()

function load(): Promise<Catalog> {
  shared ??= fetchModels().then(
    (catalog) => {
      known = catalog
      for (const listener of listeners) listener(catalog)
      return catalog
    },
    (error: unknown) => { shared = null; throw error },
  )
  return shared
}

/** Fetches the list again, as after a source is connected or removed. */
export function refreshModels(): Promise<Catalog> {
  shared = null
  return load()
}

/** The model list, once it has arrived. */
export function useModels(): { catalog: Catalog | null; error: string } {
  const [catalog, setCatalog] = useState<Catalog | null>(known)
  const [error, setError] = useState('')
  useEffect(() => {
    listeners.add(setCatalog)
    if (!known) {
      load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The model list isn’t available.'))
    }
    return () => { listeners.delete(setCatalog) }
  }, [])
  return { catalog, error }
}

/** For tests: forget the list fetched so far. */
export function forgetModels() {
  shared = null
  known = null
}
