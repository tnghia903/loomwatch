import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const needsYou = vi.hoisted(() => ({ tickets: [] as unknown[] }))
vi.mock('../../lib/story/useNeedsYou', () => ({ useNeedsYou: () => needsYou }))

import { Dock } from './Dock'

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '/agents') })
afterEach(cleanup)

const count = () => screen.getByRole('link', { name: /^Home/ }).querySelector('.lw-dock-count')

// The design review: the count popped on every page and when it went down, as if something new
// needed you. It pops only when more do (motion.css animates `.rose`).
it('marks the count to pop only when it rises', () => {
  needsYou.tickets = [{}, {}]
  const view = render(<Dock />)
  expect(count()).toHaveTextContent('2')
  expect(count()).not.toHaveClass('rose')
  needsYou.tickets = [{}]
  view.rerender(<Dock />)
  expect(count()).toHaveTextContent('1')
  expect(count()).not.toHaveClass('rose')
  needsYou.tickets = [{}, {}, {}]
  view.rerender(<Dock />)
  expect(count()).toHaveTextContent('3')
  expect(count()).toHaveClass('rose')
})
