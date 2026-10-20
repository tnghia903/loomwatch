import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import AgentFigure, { type BenchLabel } from './AgentFigure'
import type { BenchAnchors, BenchFaces, BenchView } from './workbenchScene'

// The scene needs WebGL, so it is stood in for; it hands over the callback it draws each frame with.
let onFrame: ((anchors: BenchAnchors, faces: BenchFaces) => void) | null = null
vi.mock('./workbenchScene', () => ({
  placeFace: () => {},
  WorkbenchScene: class {
    constructor(_canvas: unknown, callbacks: { onFrame: typeof onFrame }) { onFrame = callbacks.onFrame }
    set() {}
    load() { return Promise.resolve() }
    resize() {}
    start() {}
    stop() {}
    dispose() {}
    setTone() {}
  },
}))

const steps: string[] = []
beforeEach(() => {
  steps.length = 0
  onFrame = null
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  // Reading a width lays the page out first if anything moved since: each read and move is noted.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => { steps.push('read'); return 90 })
  const styles = Object.getPrototypeOf(document.createElement('div').style) as CSSStyleDeclaration
  const style = Object.getOwnPropertyDescriptor(styles, 'transform')!
  vi.spyOn(styles, 'transform', 'set').mockImplementation(function (this: CSSStyleDeclaration, value: string) { steps.push('move'); style.set!.call(this, value) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const view = { look: { name: 'Tea researcher', instructions: '' }, does: '', appName: '', mood: 'still', thought: null } as unknown as BenchView
const labels: BenchLabel[] = [
  { anchor: 'reads', part: 'reads', text: 'Reads', label: 'Reads', place: 'below' },
  { anchor: 'tools', part: 'tools', text: 'Tools', label: 'Tools', place: 'below' },
  { anchor: 'skills', part: 'skills', text: 'Skills', label: 'Skills', place: 'right' },
]
const at = { x: 200, y: 120 }
const anchors = Object.fromEntries(['mind', 'app', 'name', 'job', 'skills', 'reads', 'tools', 'keys', 'dish', 'reply', 'thought'].map((anchor) => [anchor, at])) as BenchAnchors
const quad = { x: 0, y: 0, ux: 10, uy: 0, vx: 0, vy: 10 }

// Each frame the labels follow the bench (AgentFigure.tsx, place): all their widths are read before
// any of them moves, so the page is laid out once a frame, not once for each label.
it('reads every label’s width before it moves any', () => {
  render(<AgentFigure view={view} labels={labels} open={null} onPart={vi.fn()} onKey={vi.fn()} onSkillDrop={vi.fn()} skillMime="text/x-skill" onFail={vi.fn()} />)
  expect(onFrame).not.toBeNull()
  steps.length = 0
  onFrame!(anchors, { name: quad, job: quad, app: quad })
  expect(steps.filter((step) => step === 'read')).toHaveLength(labels.length)
  expect(steps.filter((step) => step === 'move').length).toBeGreaterThanOrEqual(labels.length)
  expect(steps.lastIndexOf('read')).toBeLessThan(steps.indexOf('move'))
})
