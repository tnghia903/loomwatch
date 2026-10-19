import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CheckStep } from './CheckStep'

afterEach(cleanup)

// ADR 0062: the check step's loop in words a newcomer reads at a glance, each control writing what
// the daemon runs.
describe('CheckStep', () => {
  const panel = (props: Partial<Parameters<typeof CheckStep>[0]> = {}) => {
    const onSendBack = vi.fn()
    render(<CheckStep checkedName="Writer" checkedHasDoneWhen sendBack={{ rounds: 2, whenStillNotMet: 'ask' }} onSendBack={onSendBack} {...props} />)
    return onSendBack
  }

  it('says how many times the work goes back and what happens after, and changes each', () => {
    const onSendBack = panel()
    expect(screen.getByRole('checkbox', { name: 'Send the work back to Writer when a check isn’t met' })).toBeChecked()
    const rounds = screen.getByRole('radiogroup', { name: 'How many times the work may go back' })
    expect(rounds).toHaveTextContent('Up to123times')
    expect(screen.getByRole('radio', { name: '2' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Ask me first/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: '3' }))
    expect(onSendBack).toHaveBeenLastCalledWith({ rounds: 3, whenStillNotMet: 'ask' })
    fireEvent.click(screen.getByRole('radio', { name: /Show the answer anyway/ }))
    expect(onSendBack).toHaveBeenLastCalledWith({ rounds: 2, whenStillNotMet: 'answer' })
  })

  it('says "time" for one round', () => {
    panel({ sendBack: { rounds: 1, whenStillNotMet: 'answer' } })
    expect(screen.getByRole('radiogroup', { name: 'How many times the work may go back' })).toHaveTextContent(/time$/)
    expect(screen.getByRole('radio', { name: /Show the answer anyway/ })).toBeChecked()
  })

  it('turns sending back off and on, on as a new check step has it, and hides the rest while off', () => {
    const onSendBack = panel({ sendBack: null })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onSendBack).toHaveBeenLastCalledWith({ rounds: 2, whenStillNotMet: 'ask' })
    cleanup()
    const off = panel()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(off).toHaveBeenLastCalledWith(null)
  })

  it('nudges toward a Done when and another maker’s model, and changes nothing read-only', () => {
    const onSendBack = panel({ checkedHasDoneWhen: false, readOnly: true })
    expect(screen.getByRole('group', { name: 'Checks' })).toHaveTextContent('Writer has no Done when, and its Done when is what “checks met” means.')
    expect(screen.getByText(/a model from another maker than Writer’s, or a stronger one/)).toBeInTheDocument()
    for (const control of [screen.getByRole('checkbox'), ...screen.getAllByRole('radio')]) expect(control).toBeDisabled()
    expect(onSendBack).not.toHaveBeenCalled()
  })

  it('asks for the work to check before anything else', () => {
    panel({ checkedName: undefined })
    expect(screen.getByText('Connect the agent whose work it should check.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
