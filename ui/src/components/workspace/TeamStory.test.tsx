import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { FigureChoice } from '../../lib/library/figures'
import type { SentencePart } from '../../lib/story/teamSentence'
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
  // Each agent wears one colour everywhere: its name in the sentence is its name in the chat.
  it('names each agent in its figure’s colour, and you without one', () => {
    render(<TeamStory parts={parts} figures={figures} onAgent={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'First-principles tutor' })).toHaveClass('story-name', 'hue-5')
    const you = screen.getByRole('button', { name: 'You, the review step' })
    expect(you).toHaveClass('story-name', 'you')
    expect(you.className).not.toMatch(/hue-/)
  })
})
