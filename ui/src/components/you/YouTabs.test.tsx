import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { FEEDBACK_EVENT } from '../../lib/feedback/report'
import { YouTabs } from './YouTabs'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme') })
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/') })

it('puts About you, Connections and Usage in one row of tabs, with the one you are on marked', () => {
  window.history.replaceState(null, '', '/usage')
  render(<YouTabs />)
  const you = screen.getByRole('navigation', { name: 'You' })
  expect(within(you).getAllByRole('link').map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual([
    ['About you', '/you'], ['Connections', '/connections'], ['Usage', '/usage'],
  ])
  expect(within(you).getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
  expect(within(you).getByRole('link', { name: 'About you' })).not.toHaveAttribute('aria-current')
})

it('switches the look, starts the guide and opens feedback, which left the other screens’ menus', () => {
  render(<YouTabs />)
  const look = screen.getByRole('button', { name: /Switch to (light|dark) theme/ })
  const before = look.getAttribute('aria-label')
  fireEvent.click(look)
  expect(screen.getByRole('button', { name: /Switch to (light|dark) theme/ }).getAttribute('aria-label')).not.toBe(before)

  fireEvent.click(screen.getByRole('button', { name: 'Getting started guide' }))
  expect(JSON.parse(localStorage.getItem('loomwatch:tour') ?? '{}')).toMatchObject({ status: 'active' })

  const heard = vi.fn()
  window.addEventListener(FEEDBACK_EVENT, heard)
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
  window.removeEventListener(FEEDBACK_EVENT, heard)
  expect(heard).toHaveBeenCalledOnce()
})
