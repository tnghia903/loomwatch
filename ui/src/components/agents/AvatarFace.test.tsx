import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { figureStill } from '../../lib/library/figures'
import { AgentPortrait, AvatarFace } from './AvatarFace'
import { TeamFiguresContext } from './figureContext'

afterEach(cleanup)

const figures = new Map([['reader', { kind: 'yarn' as const, color: 'clay' as const }]])

describe('an agent’s avatar in the chat and Details', () => {
  it('is its figure when the team has one for it, and its initials when it has none', () => {
    const { container } = render(
      <TeamFiguresContext.Provider value={figures}>
        <AvatarFace id="reader" hue={2} size={28} text="Re" />
        <AvatarFace id="review" hue={0} size={28} text="You" />
      </TeamFiguresContext.Provider>,
    )
    const [reader, you] = container.querySelectorAll('.chat-avatar')
    expect(reader).toHaveClass('has-figure', 'hue-2')
    // The figure alone, as a picture: no disc of its colour behind it.
    expect(reader.querySelector('img.chat-avatar-figure')).toHaveAttribute('src', figureStill({ kind: 'yarn', color: 'clay' }))
    expect((reader as HTMLElement).style.backgroundImage).toBe('')
    expect(reader).toHaveTextContent('')
    expect(you).not.toHaveClass('has-figure')
    expect(you).toHaveTextContent('You')
  })

  it('in Details wears the figure, and you keep your ring', () => {
    const { container } = render(
      <TeamFiguresContext.Provider value={figures}>
        <AgentPortrait id="reader" size={30} />
        <AgentPortrait id="review" size={30} operator />
      </TeamFiguresContext.Provider>,
    )
    expect(container.querySelector('img.agent-portrait')).toHaveAttribute('src', figureStill({ kind: 'yarn', color: 'clay' }))
    expect(container.querySelector('.agent-mark.you')).not.toBeNull()
  })
})
