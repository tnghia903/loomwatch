import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { makeRoom, ROOM_GAP, withRoom } from './makeRoom'
import { PORT } from './ports'

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

describe('withRoom', () => {
  const node = (id: string, x: number, y: number, height = 84, width = 232): Node => ({ id, position: { x, y }, data: {}, measured: { width, height } })
  // Routed where the cards are saved, which is what the canvas builder hands over.
  const bridged: Edge = { id: 'reads', source: 'agent', target: 'folder', sourceHandle: PORT.topOut, targetHandle: PORT.top }

  it('drops the line straight down to a folder it drew below a card that grew over it', () => {
    // The enterprise RAG team at Trace: where the folder is saved, the agent card covers its top,
    // so its line bridged up over the agent and back down through it.
    const { nodes, edges } = withRoom([node('agent', 0, 0, 334), node('folder', 0, 214, 88)], [bridged], {})
    expect(nodes.find((item) => item.id === 'folder')?.position.y).toBe(334 + ROOM_GAP)
    expect(edges[0]).toMatchObject({ sourceHandle: PORT.down, targetHandle: PORT.top })
  })

  it('hands the cards and lines back untouched while nothing needs room', () => {
    const nodes = [node('agent', 0, 0), node('folder', 0, 214, 88)]
    const edges = [bridged]
    expect(withRoom(nodes, edges, {})).toEqual({ nodes, edges })
  })

  it('sizes a card the document does not own from what was measured for it', () => {
    const folder: Node = { id: 'folder', position: { x: 0, y: 214 }, data: {} }
    const { nodes } = withRoom([node('agent', 0, 0, 334), folder], [bridged], { folder: { width: 232, height: 88 } })
    expect(nodes[1].position.y).toBe(334 + ROOM_GAP)
  })
})
