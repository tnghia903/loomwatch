import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SpendLimitChip } from './SpendLimitChip'

afterEach(cleanup)

describe('what one run may spend (ADR 0068)', () => {
  it('states the figure, and saves a new one in whole cents', () => {
    const onChange = vi.fn()
    render(<SpendLimitChip perRun={1} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Each run · \$1\.00/ }))
    const field = screen.getByLabelText('One run of this team may spend up to')
    expect(field).toHaveValue(1)
    fireEvent.change(field, { target: { value: '2.499' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith(2.5)
  })

  it('can take the limit off, and starts a team with none from $1.00', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SpendLimitChip perRun={1} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Each run/ }))
    fireEvent.click(screen.getByRole('button', { name: 'No limit' }))
    expect(onChange).toHaveBeenCalledWith(null)
    rerender(<SpendLimitChip perRun={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Each run · no limit/ }))
    expect(screen.getByLabelText('One run of this team may spend up to')).toHaveValue(1)
    expect(screen.queryByRole('button', { name: 'No limit' })).toBeNull()
  })

  it('refuses nothing or less, and cannot be changed where the team file can’t be', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SpendLimitChip perRun={1} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Each run/ }))
    fireEvent.change(screen.getByLabelText('One run of this team may spend up to'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    rerender(<SpendLimitChip perRun={1} />)
    expect(screen.getByRole('button', { name: /Each run/ })).toBeDisabled()
  })
})
