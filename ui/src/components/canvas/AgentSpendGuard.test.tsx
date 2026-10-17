import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSpendGuard } from './AgentSpendGuard'

afterEach(cleanup)

describe('an agent’s own guard (ADR 0068)', () => {
  it('is empty unless set, and sets the guard once you leave the field', () => {
    const onChange = vi.fn()
    render(<AgentSpendGuard perRun={null} readOnly={false} onChange={onChange} />)
    const field = screen.getByLabelText('Stop it past, each run')
    expect(field).toHaveValue(null)
    expect(screen.getByText(/spends from the team’s limit like the others/)).toBeInTheDocument()
    fireEvent.change(field, { target: { value: '0.3' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith(0.3)
  })

  it('shows the guard as written, and passing through the field changes nothing', () => {
    // A guard under a cent, or finer than cents, used to show as `0.00` or rounded, and leaving
    // the field saved that: `0.003` became no guard at all.
    for (const perRun of [0.003, 0.255]) {
      const onChange = vi.fn()
      render(<AgentSpendGuard perRun={perRun} readOnly={false} onChange={onChange} />)
      const field = screen.getByLabelText('Stop it past, each run')
      expect(field).toHaveValue(perRun)
      fireEvent.focus(field)
      fireEvent.blur(field)
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(onChange).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('never rounds a guard you type down to no guard at all', () => {
    const onChange = vi.fn()
    render(<AgentSpendGuard perRun={null} readOnly={false} onChange={onChange} />)
    const field = screen.getByLabelText('Stop it past, each run')
    fireEvent.change(field, { target: { value: '0.004' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith(0.004)
    expect(field).toHaveValue(0.004)
  })

  it('takes the guard off when emptied, and says what a set one does', () => {
    const onChange = vi.fn()
    render(<AgentSpendGuard perRun={0.3} readOnly={false} onChange={onChange} />)
    expect(screen.getByText('Past $0.30 in a run, it waits for you to add more or to stop it.')).toBeInTheDocument()
    const field = screen.getByLabelText('Stop it past, each run')
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
