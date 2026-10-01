import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RequiredSkillReceipt } from '../../lib/watch/events'
import { SuppliedInstructions } from './SuppliedInstructions'

const RAN = 'a'.repeat(64)
const LATER = 'b'.repeat(64)
const TEXT = '# claude-design\n\nUse the tokens in DESIGN.md.'

const receipt: RequiredSkillReceipt = {
  harness: 'Codex',
  name: 'claude-design',
  source: 'Claude Code',
  sourcePath: '/home/u/.claude/skills/claude-design/SKILL.md',
  path: '/teams/.loomwatch/team/agent/.agents/skills/claude-design/SKILL.md',
  sha256: RAN,
  chars: 25010,
  state: 'supplied',
  eventId: 'e1',
}

/** The instruction body as rendered. `getByText` normalises whitespace, so a multi-line file
 *  never matches it — and the text arriving verbatim is exactly what this feature promises. */
const shown = () => document.querySelector('.supplied-text')?.textContent ?? null

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('reading back the instructions a run supplied', () => {
  it('offers the exact size the run recorded, and reads nothing until asked', () => {
    render(<SuppliedInstructions receipt={receipt} />)
    expect(screen.getByRole('button', { name: 'Read the 25,010 characters that were supplied' })).toHaveAttribute('aria-expanded', 'false')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the prepared copy the run wrote, not the operator’s own source file', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ path: receipt.path, sha256: RAN, chars: 4, content: TEXT }))
    render(<SuppliedInstructions receipt={receipt} />)
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(shown()).toBe(TEXT))
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(`/api/instructions?path=${encodeURIComponent(receipt.path)}`)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain('.claude/skills')
  })

  // The verdict is the feature. Showing the text without it would present a file that may have
  // changed as though it were this run's evidence.
  it('says it is what ran only when the fingerprint still matches', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ path: receipt.path, sha256: RAN, chars: 4, content: TEXT }))
    render(<SuppliedInstructions receipt={receipt} />)
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(screen.getByText(/This is what ran/)).toBeInTheDocument())
    expect(screen.queryByText(/Changed since this run/)).not.toBeInTheDocument()
    expect(shown()).toBe(TEXT)
  })

  it('refuses to call a changed file this run’s evidence, and names the version it found', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ path: receipt.path, sha256: LATER, chars: 4, content: TEXT }))
    render(<SuppliedInstructions receipt={receipt} />)
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(screen.getByText(/Changed since this run/)).toBeInTheDocument())
    expect(screen.queryByText(/This is what ran/)).not.toBeInTheDocument()
    expect(screen.getByText(LATER.slice(0, 12), { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/shown for reference, not as this run’s evidence/)).toBeInTheDocument()
  })

  // The prepared copy is rebuilt every run, so an older run losing it is ordinary, not an error.
  it('reports a missing prepared copy as a gap in the record, not a failure', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: 'failed to read …: No such file' }, 404))
    render(<SuppliedInstructions receipt={receipt} />)
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(screen.getByText(/Not on disk any more/)).toBeInTheDocument())
    expect(screen.queryByText(/Could not read them back/)).not.toBeInTheDocument()
    expect(shown()).toBeNull()
  })

  it('surfaces a refusal as an error rather than an empty panel', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: 'resolves outside the configured teams root' }, 403))
    render(<SuppliedInstructions receipt={receipt} />)
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(screen.getByText(/resolves outside the configured teams root/)).toBeInTheDocument())
    expect(screen.queryByText(/This is what ran/)).not.toBeInTheDocument()
  })

  it('collapses without re-reading, and never claims the agent followed anything', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ path: receipt.path, sha256: RAN, chars: 4, content: TEXT }))
    const { container } = render(<SuppliedInstructions receipt={receipt} />)
    const toggle = screen.getByRole('button', { name: /Read the 25,010 characters/ })
    fireEvent.click(toggle)
    await waitFor(() => expect(shown()).toBe(TEXT))
    expect(container.textContent).not.toMatch(/\bused\b|\bfollowed\b|\bapplied\b|verified/i)

    fireEvent.click(screen.getByRole('button', { name: 'Hide the instructions' }))
    expect(shown()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Read the 25,010 characters/ }))
    await waitFor(() => expect(shown()).toBe(TEXT))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
