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
