import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { FEEDBACK_EVENT } from '../../lib/feedback/report'
import { LABEL_USES } from '../frame/frameStore'
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

it('says each tab’s name beside its icon until it has been used as often as the dock’s places', () => {
  localStorage.setItem('loomwatch:dock:uses', JSON.stringify({ 'you:usage': LABEL_USES }))
  render(<YouTabs />)
  const name = (label: string) => screen.getByRole('link', { name: label }).querySelector('.lw-you-tab-label')
  expect(name('Connections')).toBeVisible()
  expect(name('Connections')).toHaveTextContent('Connections')
  expect(name('Usage')).not.toBeVisible()
  fireEvent.click(screen.getByRole('link', { name: 'Connections' }))
  expect(JSON.parse(localStorage.getItem('loomwatch:dock:uses') ?? '{}')).toMatchObject({ 'you:connections': 1 })
})

it('switches the look, starts the guide and opens feedback, which left the other screens’ menus', () => {
  render(<YouTabs />)
  const look = screen.getByRole('button', { name: /Switch to (light|dark) theme/ })
  const before = look.getAttribute('aria-label')
  fireEvent.click(look)
  expect(screen.getByRole('button', { name: /Switch to (light|dark) theme/ }).getAttribute('aria-label')).not.toBe(before)

  // The guide's first steps are on Home, so it starts there rather than waiting unseen here.
  const assign = vi.fn()
  vi.stubGlobal('location', { ...window.location, assign, pathname: '/you', search: '' })
  fireEvent.click(screen.getByRole('button', { name: 'Getting started guide' }))
  expect(JSON.parse(localStorage.getItem('loomwatch:tour') ?? '{}')).toMatchObject({ status: 'active' })
  expect(assign).toHaveBeenCalledWith('/')
  vi.unstubAllGlobals()

  const heard = vi.fn()
  window.addEventListener(FEEDBACK_EVENT, heard)
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
  window.removeEventListener(FEEDBACK_EVENT, heard)
  expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ screen: 'you' })
})
