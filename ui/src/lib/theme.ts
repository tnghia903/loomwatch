import { useCallback, useEffect, useState } from 'react'

// DESIGN_LANGUAGE §11: dark ("Obsidian & Gilt") is the default; light ("Quarry") and
// "follow system" are the other two states. The resolved theme is always stamped on
// <html data-theme="dark|light"> so tokens.css never needs a media-query twin.
export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'loomwatch:theme'
const CHANGE_EVENT = 'loomwatch:theme-change'

export function readThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  } catch {
    // Storage may be unavailable (private mode, sandboxed preview). Default applies.
  }
  return 'dark'
}

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.setAttribute('data-theme-mode', mode)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#08080A' : '#FAF8F3')
  return resolved
}

export function setThemeMode(mode: ThemeMode) {
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* see readThemeMode */ }
  applyTheme(mode)
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: mode }))
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode())
  const [systemLight, setSystemLight] = useState(() => systemTheme() === 'light')
  const resolved: ResolvedTheme = mode === 'system' ? (systemLight ? 'light' : 'dark') : mode

  useEffect(() => {
    applyTheme(mode)
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    const onSystem = (event: MediaQueryListEvent) => { setSystemLight(event.matches); if (mode === 'system') applyTheme('system') }
    media?.addEventListener?.('change', onSystem)
    const onChange = (event: Event) => setMode((event as CustomEvent<ThemeMode>).detail)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => {
      media?.removeEventListener?.('change', onSystem)
      window.removeEventListener(CHANGE_EVENT, onChange)
    }
  }, [mode])

  /** The toggle is binary (dark ⇄ light); "system" lives in ⌘K only, per UX_REDESIGN §11. */
  const toggle = useCallback(() => setThemeMode(resolved === 'dark' ? 'light' : 'dark'), [resolved])
  const followSystem = useCallback(() => setThemeMode('system'), [])

  return { mode, resolved, toggle, followSystem, setMode: setThemeMode }
}
