import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { LIBRARY_DRAG_MIME } from './constants'
import { Library } from './Library'

const openCode: DetectedHarness = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  executablePath: '/usr/local/bin/opencode',
  spawn: { cmd: 'opencode', args: ['acp'] },
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
})

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

describe('Library', () => {
  it('shows detected harness rows and their counts', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.getByLabelText('Detected harnesses')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('opencode acp')).toBeInTheDocument()
  })

  it('lists the other three known harnesses as not installed', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    fireEvent.click(screen.getByRole('button', { name: /not installed/i }))
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
  })

  it('shows the search-path empty state when nothing is detected', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.getByText('No agent harnesses found on PATH.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show search path'))
    expect(screen.getByText(/claude, codex, gemini, opencode/)).toBeInTheDocument()
  })

  it('shows the presets fixtures and the empty endpoints state', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Protocol Researcher')).toBeInTheDocument()
    expect(screen.getByText(/Add an endpoint to reach a model/)).toBeInTheDocument()
  })

  it('puts the source payload on dataTransfer when a row drag starts', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    const row = screen.getByLabelText('OpenCode, drag onto the canvas to add it')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(LIBRARY_DRAG_MIME, expect.stringContaining('"OpenCode"'))
  })

  it('does not make the not-installed rows draggable', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    fireEvent.click(screen.getByRole('button', { name: /not installed/i }))
    const row = screen.getByLabelText('Claude, not found on PATH')
    expect(row).toHaveAttribute('draggable', 'false')
  })

  it('uses a collapsed rail and scrim-backed sheet at tablet widths', () => {
    setWindowWidth(900)
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)

    expect(screen.getByRole('toolbar', { name: 'Library, collapsed' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Library' }))
    expect(screen.getByRole('region', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close Library' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close Library' }))
    expect(screen.getByRole('toolbar', { name: 'Library, collapsed' })).toBeInTheDocument()
  })
})
