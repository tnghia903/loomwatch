import { describe, expect, it } from 'vitest'
import { wordDiff, type DiffPart } from './wordDiff'

const side = (parts: DiffPart[], drop: DiffPart['kind']) => parts.filter((part) => part.kind !== drop).map((part) => part.text).join('')

describe('wordDiff', () => {
  it('marks the words taken out and put in, and keeps the rest as one run', () => {
    const before = 'Establish the problem from the EKIS Notion page and the run request.'
    const after = 'Establish the problem from the run request.'
    expect(wordDiff(before, after)).toEqual([
      { kind: 'same', text: 'Establish the problem from the ' },
      { kind: 'removed', text: 'EKIS Notion page and the ' },
      { kind: 'same', text: 'run request.' },
    ])
  })

  it('joins back into each version exactly, line breaks included', () => {
    const before = 'Plan first.\nLocate the EKIS page.\n\nReply with a brief.'
    const after = 'Plan first.\n\nReply with a short brief and sources.'
    const parts = wordDiff(before, after)
    expect(side(parts, 'added')).toBe(before)
    expect(side(parts, 'removed')).toBe(after)
  })

  it('has nothing to mark when nothing changed', () => {
    expect(wordDiff('Same words.', 'Same words.')).toEqual([{ kind: 'same', text: 'Same words.' }])
    expect(wordDiff('', '')).toEqual([])
  })
})
