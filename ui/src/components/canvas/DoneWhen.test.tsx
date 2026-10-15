import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DoneWhen } from './DoneWhen'

afterEach(cleanup)

describe('DoneWhen', () => {
  it('says nothing is set, and adds a written line only', () => {
    const onChange = vi.fn()
    render(<DoneWhen items={[]} onChange={onChange} />)
    expect(screen.getByRole('group', { name: 'Done when' })).toHaveTextContent('Nothing set')
    const input = screen.getByRole('textbox', { name: 'Add to done when' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' Every claim links to its source ' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(onChange).toHaveBeenCalledWith(['Every claim links to its source'])
  })

  it('edits a line when it is left, removes an emptied one, and stops at five', () => {
    const onChange = vi.fn()
    const items = ['One', 'Two']
    const { rerender } = render(<DoneWhen items={items} onChange={onChange} />)
    const first = screen.getByRole('textbox', { name: 'Done when, item 1' })
    fireEvent.change(first, { target: { value: 'First' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(first)
    expect(onChange).toHaveBeenLastCalledWith(['First', 'Two'])
    const second = screen.getByRole('textbox', { name: 'Done when, item 2' })
    fireEvent.change(second, { target: { value: ' ' } })
    fireEvent.blur(second)
    expect(onChange).toHaveBeenLastCalledWith(['One'])
    rerender(<DoneWhen items={['a', 'b', 'c', 'd', 'e']} onChange={onChange} />)
    expect(screen.queryByRole('textbox', { name: 'Add to done when' })).not.toBeInTheDocument()
    expect(screen.getByText(/Five is the most/)).toBeInTheDocument()
  })

  it('changes nothing when it is read-only', () => {
    render(<DoneWhen items={['One']} readOnly onChange={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Add to done when' })).not.toBeInTheDocument()
  })
})
