import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TurnedOffNote } from './TurnedOffNote'

afterEach(cleanup)

const names = new Map([['scope', 'Project scope'], ['plan', 'Plan writer']])

describe('TurnedOffNote', () => {
  it('says what a removal turned off for the whole team, and goes when dismissed', () => {
    const onDismiss = vi.fn()
    render(<TurnedOffNote note={{ names: ['canvas-design'], agents: ['scope', 'plan'], everyone: true }} names={names} onDismiss={onDismiss} />)
    expect(screen.getByRole('status')).toHaveTextContent("Turned off canvas-design for every agent in this team. They won't use it on later runs, even from LoomWatch’s library.")
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('names the one agent a removed line turned it off for', () => {
    render(<TurnedOffNote note={{ names: ['agentmemory'], agents: ['plan'], everyone: false }} names={names} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent("Turned off agentmemory for Plan writer. It won't use it on later runs")
  })

  it('counts the agents when it was not every one, and says where to turn it back on', () => {
    render(<TurnedOffNote note={{ names: ['house-style', 'pdf'], agents: ['scope', 'plan'], everyone: false }} names={names} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent("Turned off house-style and pdf for 2 agents. They won't use them on later runs, even from LoomWatch’s library. Each agent's panel can turn them back on.")
  })
})
