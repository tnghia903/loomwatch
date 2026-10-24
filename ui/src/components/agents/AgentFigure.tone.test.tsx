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

// The island's box (ADR 0083, decision 11) draws the bench in its own dark, whatever the app's
// theme: given a tone, the bench neither reads the app's theme nor writes it onto the page.
it('in a tone of its own, keeps it and leaves the page’s theme alone', () => {
  localStorage.setItem('loomwatch:theme', 'light')
  document.documentElement.setAttribute('data-theme', 'dark')
  render(<AgentFigure view={view} labels={[]} open={null} onPart={vi.fn()} onKey={vi.fn()} onSkillDrop={vi.fn()} skillMime="text/x-skill" onFail={vi.fn()} tone="dark" readOnly />)
  expect(tones).toEqual(['dark'])
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
})

// To look at only: its labels say what each thing is, in words, and none is a button to press.
it('read only, draws its labels as words, not buttons, and a plate it names in the picture not at all', () => {
  const labels = [
    { anchor: 'job' as const, part: 'job' as const, place: 'above' as const, text: 'The job', short: 'Job', label: 'The job on the clipboard: its instructions' },
    { anchor: 'name' as const, part: 'name' as const, place: 'plate' as const, label: 'The nameplate: Tea researcher' },
  ]
  const onPart = vi.fn()
  const { container } = render(<AgentFigure view={view} labels={labels} open={null} onPart={onPart} onKey={vi.fn()} onSkillDrop={vi.fn()} skillMime="text/x-skill" onFail={vi.fn()} tone="dark" readOnly />)
  expect(container.querySelectorAll('button')).toHaveLength(0)
  const tags = [...container.querySelectorAll<HTMLElement>('.bench-tag')]
  expect(tags.map((tag) => tag.getAttribute('aria-label'))).toEqual(['The job on the clipboard: its instructions'])
  expect(container.querySelector('.bench-stage')?.classList.contains('read-only')).toBe(true)
})
