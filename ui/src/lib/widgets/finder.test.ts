import { describe, expect, it } from 'vitest'

import { walkFinder } from './finder'

const visa = {
  kind: 'finder' as const,
  title: 'Do you need a visa for Japan?',
  questions: [
    { text: 'Which passport do you hold?', answers: [{ label: 'US, UK or EU', outcome: 1 }, { label: 'Vietnam', next: 3 }] },
    { text: 'Never asked from Vietnam', answers: [{ label: 'a', outcome: 1 }, { label: 'b', outcome: 2 }] },
    { text: 'How long will you stay?', answers: [{ label: 'Up to 15 days', outcome: 2 }, { label: 'Longer', outcome: 1 }] },
  ],
  outcomes: [{ label: 'No visa needed' }, { label: 'An e-visa' }],
}

describe('a finder', () => {
  it('follows each answer to the question it leads to, skipping the rest, to an outcome', () => {
    expect(walkFinder(visa, []).asking?.question.text).toBe('Which passport do you hold?')
    const partway = walkFinder(visa, [1])
    expect(partway.path.map((step) => step.answer.label)).toEqual(['Vietnam'])
    expect(partway.asking?.question.text).toBe('How long will you stay?')
    const done = walkFinder(visa, [1, 0])
    expect(done.asking).toBeNull()
    expect(done.outcome?.label).toBe('An e-visa')
    expect(walkFinder(visa, [0]).outcome?.label).toBe('No visa needed')
  })

  it('stops at an answer that doesn’t follow, and reads nothing after the outcome', () => {
    expect(walkFinder(visa, [1, 9]).asking?.question.text).toBe('How long will you stay?')
    expect(walkFinder(visa, [0, 1]).path).toHaveLength(1)
  })
})
