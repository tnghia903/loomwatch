import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { setThemeMode } from '../../lib/theme'
import AgentFigure from './AgentFigure'
import type { BenchView } from './workbenchScene'

// The scene needs WebGL, so it is stood in for: what matters here is what the figure tells it.
const tones: string[] = []
vi.mock('./workbenchScene', () => ({
  placeFace: () => {},
  WorkbenchScene: class {
    set() {}
    load() { return Promise.resolve() }
    resize() {}
    start() {}
    stop() {}
    dispose() {}
    setTone(tone: string) { tones.push(tone) }
  },
}))

beforeEach(() => {
  tones.length = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.removeItem('loomwatch:theme') })

const view = { look: { name: 'Tea researcher', instructions: '' }, does: '', appName: '', mood: 'quiet', thought: null } as unknown as BenchView

// The bench's furniture follows the app's theme (workbenchScene.ts, FURNITURE): told on the way in,
// and again whenever the theme changes.
it('tells the bench the app’s theme, and again when it changes', () => {
  setThemeMode('light')
  render(<AgentFigure view={view} labels={[]} open={null} onPart={vi.fn()} onKey={vi.fn()} onSkillDrop={vi.fn()} skillMime="text/x-skill" onFail={vi.fn()} />)
  expect(tones).toEqual(['light'])
  act(() => setThemeMode('dark'))
  act(() => setThemeMode('light'))
  expect(tones).toEqual(['light', 'dark', 'light'])
})
