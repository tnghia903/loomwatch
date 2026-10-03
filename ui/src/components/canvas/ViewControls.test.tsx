import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ViewControls } from './ViewControls'

const flow = vi.hoisted(() => ({ zoomTo: vi.fn(), setCenter: vi.fn(), getNodes: vi.fn(() => []) }))
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => flow,
  useStore: (selector: (state: { transform: [number, number, number]; minZoom: number; maxZoom: number }) => unknown) => selector({ transform: [0, 0, 1], minZoom: 0.35, maxZoom: 1.5 }),
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

// ADR 0043: the dial is the bar's one zoom control. −, + and Fit did what the dial, the wheel and
// the zoom keys already do; Story now frames the whole team, as Fit did.
it('zooms only through the dial, and Story frames the whole team', () => {
  const onFit = vi.fn()
  render(<ViewControls onFit={onFit} onOrganize={vi.fn()} />)
  for (const name of ['Zoom in', 'Zoom out', 'Fit view']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  expect(screen.getByText('100%')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: 'Story' }))
  expect(onFit).toHaveBeenCalledOnce()
  expect(flow.zoomTo).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Trace' }))
  expect(flow.zoomTo).toHaveBeenCalledWith(1.4, { duration: 320 })
})
