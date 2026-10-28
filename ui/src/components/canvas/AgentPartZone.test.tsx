import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { tidyPart } from '../../lib/team-file/part'
import { AgentPartZone } from './AgentPartZone'

afterEach(cleanup)

describe('an agent’s part in this team (ADR 0097)', () => {
  it('writes what the team needs when the field is left, beside the items it keeps', () => {
    const onChange = vi.fn()
    render(<AgentPartZone part={{ doneWhen: ['Covers the three options'] }} onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: 'What this team needs from it' })
    fireEvent.change(field, { target: { value: '  Design the gate for the SUTD project.  ' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith({ text: 'Design the gate for the SUTD project.', doneWhen: ['Covers the three options'] })
  })

  it('adds an item to this team’s Done when, not the agent’s own', () => {
    const onChange = vi.fn()
    render(<AgentPartZone part={{ text: 'Design the gate.' }} onChange={onChange} />)
    const add = screen.getByRole('textbox', { name: 'Add to done when in this team' })
    fireEvent.change(add, { target: { value: 'Follows the option Colin approved' } })
    fireEvent.submit(add.closest('form') as HTMLFormElement)
    expect(onChange).toHaveBeenCalledWith({ text: 'Design the gate.', doneWhen: ['Follows the option Colin approved'] })
  })

  it('takes the part out once it says nothing', () => {
    const onChange = vi.fn()
    render(<AgentPartZone part={{ text: 'Design the gate.' }} onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: 'What this team needs from it' })
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith(undefined)
    expect(tidyPart({ text: ' ', doneWhen: [] })).toBeUndefined()
    expect(tidyPart({ doneWhen: ['A', ' '] })).toEqual({ doneWhen: ['A'] })
  })

  it('shows the part read only where the team can’t be changed', () => {
    render(<AgentPartZone part={{ text: 'Design the gate.' }} readOnly onChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'What this team needs from it' })).toHaveProperty('readOnly', true)
    expect(screen.queryByRole('textbox', { name: 'Add to done when in this team' })).toBeNull()
  })
})
