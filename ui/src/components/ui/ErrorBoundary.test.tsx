import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ParseFailureModal } from '../canvas/ParseFailureModal'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(cleanup)

function Broken(): never {
  throw new Error('Cannot read properties of undefined (reading \'map\')')
}

// A render error used to unmount everything and leave a blank page with no way back.
it('replaces a crashed screen with a way back instead of a blank page', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<ErrorBoundary><Broken /></ErrorBoundary>)
  expect(screen.getByRole('alertdialog', { name: 'Something went wrong' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Back to your teams' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  quiet.mockRestore()
})

it('offers a report that carries the error, so a tester can send it in one click', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
  render(<ErrorBoundary><Broken /></ErrorBoundary>)
  const link = screen.getByRole('link', { name: 'Report this problem' })
  const url = new URL(link.getAttribute('href') ?? '')
  expect(url.searchParams.get('template')).toBe('bug_report.yml')
  expect(url.searchParams.get('title')).toBe('Error: Cannot read properties of undefined (reading \'map\')')
  expect(url.searchParams.get('details')).toContain('Error: Cannot read properties of undefined (reading \'map\')')
  expect(link).toHaveAttribute('target', '_blank')
  vi.unstubAllGlobals()
  quiet.mockRestore()
})

it('says "not a team" for YAML that is not a team, and "not valid YAML" for broken YAML', () => {
  const { unmount } = render(<ParseFailureModal failure={{ kind: 'shape', message: 'It doesn’t describe a team.', line: null }} />)
  expect(screen.getByText('This file isn’t a LoomWatch team.')).toBeInTheDocument()
  unmount()
  render(<ParseFailureModal failure={{ kind: 'yaml', message: 'bad indentation at line 2', line: 'a: [' }} />)
  expect(screen.getByText('This file isn’t valid YAML.')).toBeInTheDocument()
})
