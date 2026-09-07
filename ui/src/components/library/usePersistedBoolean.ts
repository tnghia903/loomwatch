import { useState } from 'react'

// "Open/closed state persists per browser" (§4) and the rail collapse (§4.4) both need this.
export function usePersistedBoolean(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const storageKey = `loomwatch.library.${key}`
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return initial
    }
    const stored = window.localStorage.getItem(storageKey)
    return stored === null ? initial : stored === 'true'
  })

  const set = (next: boolean) => {
    setValue(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, String(next))
    }
  }

  return [value, set]
}
