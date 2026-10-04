import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { openFeedback, type AboutLoomWatch } from '../../lib/feedback/report'
import { Feedback } from './Feedback'

const about: AboutLoomWatch = { version: '0.1.0', commit: 'b4e3373', os: 'macos', osVersion: '26.0', arch: 'aarch64' }
const harnesses: DetectedHarness[] = [
  { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/Users/someone/.local/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: [] } },
  { id: 'gemini', name: 'Gemini', command: 'gemini', executablePath: '/Users/someone/.local/bin/gemini', acpAvailable: true, health: 'error', healthReason: 'This client is no longer supported.', spawn: { cmd: 'gemini', args: ['--acp'] } },
]

let aboutAnswer: () => Promise<Response>
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  aboutAnswer = () => Promise.resolve(new Response(JSON.stringify(about), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/about' ? aboutAnswer() : Promise.reject(new Error(`unexpected ${url}`)))))
  writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function details(): string {
  return screen.getByText(/^LoomWatch:/).textContent ?? ''
}

function githubLink(): URL {
  return new URL(screen.getByRole('link', { name: /Continue on GitHub/ }).getAttribute('href') ?? '')
}

describe('Send feedback', () => {
  it('opens from anywhere and shows exactly what the report will carry', async () => {
    render(<Feedback harnesses={harnesses} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openFeedback({ screen: 'run' }))
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument()
    await waitFor(() => expect(details()).toContain('LoomWatch: 0.1.0 (b4e3373)'))
    expect(details()).toContain('System: macOS 26.0 (aarch64)')
    expect(details()).toContain('Screen: Run (watching a run)')
    expect(details()).toContain("Gemini (can't start: This client is no longer supported.)")
    // Where an app is installed names the operator's account; it never goes in.
    expect(details()).not.toContain('someone')
    // The link carries the same text the dialog shows.
    expect(githubLink().searchParams.get('details')).toBe(details())
  })

  it('opens the form that matches what is being sent, in a new tab', async () => {
    render(<Feedback harnesses={harnesses} />)
    act(() => openFeedback())
    await waitFor(() => expect(details()).toContain('b4e3373'))
    const link = screen.getByRole('link', { name: /Continue on GitHub/ })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(githubLink().searchParams.get('template')).toBe('bug_report.yml')
    fireEvent.click(screen.getByRole('radio', { name: /An idea or suggestion/ }))
    expect(githubLink().searchParams.get('template')).toBe('feedback.yml')
  })

  it('still offers a report when the server does not answer', async () => {
    aboutAnswer = () => Promise.reject(new TypeError('Failed to fetch'))
    render(<Feedback harnesses={[]} />)
    act(() => openFeedback())
    await waitFor(() => expect(screen.getByText(/^LoomWatch:/).getAttribute('aria-busy')).toBe('false'))
    expect(details()).toContain('LoomWatch: unknown (the LoomWatch server did not answer)')
    expect(details()).toContain('AI apps: none found')
  })

  it('copies the details for someone without a GitHub account', async () => {
    render(<Feedback harnesses={harnesses} />)
    act(() => openFeedback())
    await waitFor(() => expect(details()).toContain('b4e3373'))
    // The repository is public: anyone with a free account can post, and nobody "invited" them.
    expect(screen.getByText(/^Posting needs a free GitHub account\. No account\? Copy the details and share them, with what happened, where you found LoomWatch\.$/)).toBeInTheDocument()
    expect(screen.queryByText(/access to LoomWatch|invited you/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(writeText).toHaveBeenCalledWith(details())
  })

  it('closes with Escape, Cancel, or after handing over to GitHub', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Feedback harnesses={harnesses} />)
    act(() => openFeedback())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => openFeedback())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => openFeedback())
    fireEvent.click(screen.getByRole('link', { name: /Continue on GitHub/ }))
    // Still there during its own click, so the browser can follow the link.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    act(() => { vi.runAllTimers() })
    expect(screen.queryByRole('dialog')).toBeNull()
    vi.useRealTimers()
  })
})
