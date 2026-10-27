import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FigureChoice } from '../../lib/library/figures'
import type { SentencePart } from '../../lib/story/teamSentence'
import { cascaded, px } from '../../test/cascade'
import { TeamStory } from './TeamStory'

const parts: SentencePart[] = [
  { kind: 'text', text: 'When you ask, ' },
  { kind: 'agent', id: 'tutor', name: 'First-principles tutor', operator: false, title: 'tutor' },
  { kind: 'text', text: ' designs, and ' },
  { kind: 'agent', id: 'review', name: 'You', operator: true, title: 'review' },
  { kind: 'text', text: ' check it.' },
]
const figures = new Map<string, FigureChoice>([['tutor', { kind: 'spool', color: 'lilac' }]])

describe('the team in one sentence', () => {
  afterEach(cleanup)

  // Each agent wears one colour everywhere: its name in the sentence is its name in the chat.
  it('names each agent in its figure’s colour, and you without one', () => {
    render(<TeamStory parts={parts} figures={figures} onAgent={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'First-principles tutor' })).toHaveClass('story-name', 'hue-5')
    const you = screen.getByRole('button', { name: 'You, the review step' })
    expect(you).toHaveClass('story-name', 'you')
    expect(you.className).not.toMatch(/hue-/)
  })

  // One chip for an agent wherever it is named: the sentence's is the chat's, drawn larger.
  it('draws each name as the agent’s chip from the chat, at the sentence’s size', () => {
    render(<TeamStory parts={parts} figures={figures} onAgent={vi.fn()} />)
    const tutor = screen.getByRole('button', { name: 'First-principles tutor' })
    expect(tutor).toHaveClass('tc-mention')
    expect(tutor.querySelector('.tc-mention-face')).toHaveAttribute('aria-hidden', 'true')
    expect(tutor.querySelector('.tc-mention-face img')).not.toBeNull()
    expect(tutor.querySelector('.tc-mention-name')).toHaveTextContent('First-principles tutor')
    const inChat = document.createElement('span')
    inChat.className = 'tc-mention hue-5'
    document.body.append(inChat)
    expect([cascaded(inChat, '--chip'), cascaded(tutor, '--chip')]).toEqual(['22px', '28px'])
    expect(cascaded(tutor, 'font-size')).toBe('13px')
    // The chip and the head in it really take the sentence's size.
    const sized = (element: Element, property: string) => {
      const value = (cascaded(element, property) ?? '').replace(/var\(--chip\)/g, cascaded(tutor, '--chip') ?? '')
      const less = /^calc\(([\d.]+)px\s*-\s*([\d.]+)px\)$/.exec(value)
      return less ? Number(less[1]) - Number(less[2]) : px(value)
    }
    const face = tutor.querySelector('.tc-mention-face')!
    expect([sized(tutor, 'height'), sized(face, 'width'), sized(face, 'height')]).toEqual([28, 26, 26])
    for (const property of ['height', ['padding', 'padding-left', 'padding-right'], 'border', 'background', 'color']) {
      expect(cascaded(tutor, property), String(property)).toBe(cascaded(inChat, property))
      expect(cascaded(tutor, property), String(property)).not.toBeNull()
    }
    inChat.remove()
  })
})
