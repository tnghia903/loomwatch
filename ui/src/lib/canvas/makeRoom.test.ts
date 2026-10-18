import { describe, expect, it } from 'vitest'

import { makeRoom, ROOM_GAP } from './makeRoom'

const card = (id: string, x: number, y: number, height = 84, width = 232) => ({ id, x, y, width, height })

describe('makeRoom', () => {
  it('moves nothing while every card clears the one above it', () => {
    expect(makeRoom([card('agent', 0, 0), card('folder', 0, 214, 88)]).size).toBe(0)
  })

  it('draws a folder below an agent card that grew over it', () => {
    // The enterprise RAG team at Trace: the agent card grows to 334 and the folder sat at 214.
    const shifts = makeRoom([card('agent', 0, 0, 334), card('folder', 0, 214, 88)])
    expect(shifts.get('folder')).toBe(334 + ROOM_GAP - 214)
    expect(shifts.has('agent')).toBe(false)
  })

  it('carries the push down a stack of resources', () => {
    const shifts = makeRoom([card('agent', 0, 0, 334), card('folder', 0, 214, 88), card('skill', 0, 334, 88)])
    const folderTop = 214 + shifts.get('folder')!
    expect(334 + shifts.get('skill')!).toBe(folderTop + 88 + ROOM_GAP)
  })

  it('leaves a card in another column alone', () => {
    const shifts = makeRoom([card('agent', 0, 0, 334), card('checker', 382, 0, 300), card('output', 764, 120, 70)])
    expect(shifts.size).toBe(0)
  })

  it('pushes a card that shares only part of a column', () => {
    expect(makeRoom([card('agent', 0, 0, 334), card('skill', 200, 214, 88)]).get('skill')).toBe(160)
  })

  it('leaves a card that has not been measured where it is, and lets it push nothing', () => {
    const shifts = makeRoom([{ id: 'agent', x: 0, y: 0 }, card('folder', 0, 20, 88), { id: 'new', x: 0, y: 40 }])
    expect(shifts.size).toBe(0)
  })

  it('does not split cards that start on the same row', () => {
    expect(makeRoom([card('a', 0, 0, 334), card('b', 100, 0, 334)]).size).toBe(0)
  })

  it('gives the same answer whatever order the cards arrive in', () => {
    const cards = [card('agent', 0, 0, 334), card('folder', 0, 214, 88), card('skill', 0, 334, 88), card('checker', 382, 0, 300)]
    expect(makeRoom([...cards].reverse())).toEqual(makeRoom(cards))
  })
})
