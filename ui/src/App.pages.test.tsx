import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import App from './App'

// Nothing answers: what matters is what each page shows on its very first draw.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

// Each page comes with the app (App.tsx), so opening one draws the page itself at once, its way
// back included, not a "Loading…" line that React keeps up for 300 ms once the page's code is in.
it.each(['/usage', '/agents', '/skills', '/quests', '/connections', '/you'])('%s draws the page at once', (path) => {
  window.history.replaceState({}, '', path)
  render(<App />)
  expect(screen.getAllByRole('link').length).toBeGreaterThan(0)
})
