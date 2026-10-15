import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotionOffer, TurnedOffNote } from './TurnedOffNote'

afterEach(cleanup)

const names = new Map([['scope', 'Project scope'], ['plan', 'Plan writer']])

describe('TurnedOffNote', () => {
  it('says what a removal turned off for the whole team, and goes when dismissed', () => {
    const onDismiss = vi.fn()
    render(<TurnedOffNote note={{ names: ['canvas-design'], agents: ['scope', 'plan'], tools: false, everyone: true }} names={names} stillOwn={[]} onDismiss={onDismiss} />)
    expect(screen.getByRole('status')).toHaveTextContent("Turned off canvas-design for every agent in this team. They won't use it on later runs, even from their own app.")
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('names the one agent a removed line turned it off for, and says when its app keeps its own copy', () => {
    render(<TurnedOffNote note={{ names: ['agentmemory'], agents: ['plan'], tools: true, everyone: false }} names={names} stillOwn={['Codex']} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Turned off agentmemory for Plan writer. LoomWatch stops giving it, but Codex can still use its own copy.')
  })

  it('counts the agents when it was not every one, and says where to turn it back on', () => {
    render(<TurnedOffNote note={{ names: ['claude.ai Notion'], agents: ['scope', 'plan'], tools: true, everyone: false }} names={names} stillOwn={[]} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent("Turned off claude.ai Notion for 2 agents. They won't use it on later runs, even from their own app. Each agent's panel can turn it back on.")
  })
})

describe('NotionOffer', () => {
  it('offers to turn off Notion for the Claude agents that can still reach it, or to keep it', () => {
    const onTurnOff = vi.fn()
    const onKeep = vi.fn()
    render(<NotionOffer agents={['scope', 'plan']} onTurnOff={onTurnOff} onKeep={onKeep} />)
    expect(screen.getByRole('status')).toHaveTextContent('Your 2 Claude agents can still reach Notion through your claude.ai account.')
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Notion for this team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(onTurnOff).toHaveBeenCalledTimes(1)
    expect(onKeep).toHaveBeenCalledTimes(1)
  })
})
