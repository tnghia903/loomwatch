import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DocumentChip } from './DocumentChip'

const baseProps = {
  path: '/Users/operator/.loomwatch/teams/research.yaml',
  saveState: 'invalid' as const,
  saveError: null,
  entrypointProblem: null,
  documentProblems: [],
  fieldProblemsByAgent: new Map(),
  agentNames: new Map([['ada', 'Ada']]),
  isValid: false,
  readOnlyReason: null,
  onSave: vi.fn(),
  onReload: vi.fn(),
  onShowYaml: vi.fn(),
}

describe('DocumentChip recovery states', () => {
  it('renders every problem included in the invalid count and selects targeted problems', () => {
    const onSelectProblem = vi.fn()
    render(<DocumentChip
      {...baseProps}
      entrypointProblem={{ message: 'This team has no entry point.', candidates: [] }}
      fieldProblemsByAgent={new Map([['ada', { role: { weight: 'incomplete', message: 'Required' } }]])}
      documentProblems={[{ message: 'Duplicate edge `ada → reviewer`.', edge: { from: 'ada', to: 'reviewer' } }]}
      onSelectProblem={onSelectProblem}
    />)

    expect(screen.getByText('3 problems')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByText('This team has no entry point.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ada · Role: Required' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate edge `ada → reviewer`.' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ada · Role: Required' }))
    expect(onSelectProblem).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ada' }))

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate edge `ada → reviewer`.' }))
    expect(onSelectProblem).toHaveBeenCalledWith(expect.objectContaining({ edge: { from: 'ada', to: 'reviewer' } }))
  })

  it('shows the absolute path in details', () => {
    render(<DocumentChip {...baseProps} saveState="clean" isValid />)

    fireEvent.click(screen.getByRole('button', { name: 'research.yaml' }))
    expect(screen.getByText('/Users/operator/.loomwatch/teams/research.yaml')).toBeInTheDocument()
  })

  it('labels a missing file explicitly and offers Save a copy', () => {
    const onSaveCopy = vi.fn()
    render(<DocumentChip {...baseProps} saveState="read-only" readOnlyReason="File is gone." fileGone onSaveCopy={onSaveCopy} />)

    expect(screen.getByText('File is gone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save a copy…' }))
    expect(onSaveCopy).toHaveBeenCalledOnce()
  })
})
