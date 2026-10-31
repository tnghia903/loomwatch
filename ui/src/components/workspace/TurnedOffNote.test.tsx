import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TurnedOffNote } from './TurnedOffNote'

afterEach(cleanup)

const names = new Map([['scope', 'Project scope'], ['plan', 'Plan writer']])

describe('TurnedOffNote', () => {
  it('says what a removal turned off for the whole team, and goes when dismissed', () => {
    const onDismiss = vi.fn()
    render(<TurnedOffNote note={{ names: ['canvas-design'], agents: ['scope', 'plan'], everyone: true }} names={names} onDismiss={onDismiss} />)
    expect(screen.getByRole('status')).toHaveTextContent('Turned off canvas-design for every agent in this team. Select an agent to turn it back on.')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('names the one agent a removed line turned it off for, in this team only', () => {
    render(<TurnedOffNote note={{ names: ['agentmemory'], agents: ['plan'], everyone: false }} names={names} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Turned off agentmemory for Plan writer in this team only. Select Plan writer to turn it back on, or press Edit Plan writer to change its skills and tools in every team.')
  })

  it('counts the agents when it was not every one, and says where to turn it back on', () => {
    render(<TurnedOffNote note={{ names: ['house-style', 'pdf'], agents: ['scope', 'plan'], everyone: false }} names={names} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Turned off house-style and pdf for 2 agents in this team. Select an agent to turn them back on.')
  })

  it('says a read of the agent’s own came off it in every team it’s in', () => {
    render(<TurnedOffNote note={{ names: ['Style guide'], agents: ['plan'], everyone: false, ownRead: true }} names={names} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Took Style guide off Plan writer in every team it’s in, since it’s one of its own reads. To give it back, select Plan writer and press Edit Plan writer.')
  })
})
