import { Position, type Edge, type Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { assignPorts, choosePorts, linePoints, PORT, portAt, type Box } from './ports'

const card = (x: number, y: number, width = 240, height = 100): Box => ({ x, y, width, height })
const node = (id: string, box: Box): Node => ({ id, position: { x: box.x, y: box.y }, data: {}, measured: { width: box.width, height: box.height } })
const edge = (source: string, target: string): Edge => ({ id: `${source}->${target}`, source, target })

describe('choosePorts', () => {
  it('relays straight along a clear row', () => {
    expect(choosePorts(card(0, 0), card(400, 0), [], false)).toEqual({ sourceHandle: null, targetHandle: null })
  })

  it('drops to a single card below', () => {
    expect(choosePorts(card(0, 0), card(20, 200), [], false)).toEqual({ sourceHandle: PORT.down, targetHandle: PORT.top })
  })

  it('bridges back to a card on the left, top to top, rather than running back through the row', () => {
    expect(choosePorts(card(400, 0), card(0, 0), [], false)).toEqual({ sourceHandle: PORT.topOut, targetHandle: PORT.top })
  })

  it('bridges over a card standing in the relay’s way', () => {
    expect(choosePorts(card(0, 0), card(800, 0), [card(400, 0)], false)).toEqual({ sourceHandle: PORT.topOut, targetHandle: PORT.top })
  })

  it('goes under when going over would cross a card too', () => {
    const between = card(400, 0)
    const above = card(300, -200, 600, 100)
    expect(choosePorts(card(0, 0), card(800, 0), [between, above], false)).toEqual({ sourceHandle: PORT.down, targetHandle: PORT.bottomIn })
  })

  it('runs backwards, left side to right side, only when both bridges would cross a card', () => {
    const above = card(0, -200, 700, 100)
    const below = card(0, 150, 700, 100)
    expect(choosePorts(card(400, 0), card(0, 0), [above, below], false)).toEqual({ sourceHandle: PORT.leftOut, targetHandle: PORT.rightIn })
  })

  it('drops to a card below and to the left, rather than running back past the card beside it', () => {
    // Fact checker, right of the RAG researcher, reading a folder under the researcher: down, along
    // under the row, down into the folder's top. Leaving by the left would run back into the
    // researcher's line coming in.
    const researcher = card(0, 0)
    expect(choosePorts(card(500, 0), card(0, 300), [researcher], false)).toEqual({ sourceHandle: PORT.down, targetHandle: PORT.top })
  })

  it('relays to a card below and to the right, keeping work flowing left to right', () => {
    expect(choosePorts(card(0, 0), card(400, 300), [], false)).toEqual({ sourceHandle: null, targetHandle: null })
  })

  it('keeps the relay when a nearby card is not actually on its path', () => {
    // A card above the source's column, like the Prompt over the Run card, does not block a relay
    // that leaves to the right of it.
    const prompt = card(0, -200, 360, 112)
    expect(choosePorts(card(65, 0, 230, 80), card(460, -200), [prompt], false)).toEqual({ sourceHandle: null, targetHandle: null })
  })
})

describe('assignPorts', () => {
  it('turns several cards stacked under one card into a tree off a single trunk', () => {
    const nodes = [node('agent', card(0, 0)), node('skill', card(0, 200, 240, 72)), node('event', card(0, 320, 190, 90))]
    const routed = assignPorts([edge('agent', 'skill'), edge('agent', 'event')], nodes)
    expect(routed.map((item) => [item.sourceHandle, item.targetHandle])).toEqual([[PORT.down, null], [PORT.down, null]])
    // One trunk for the whole column: 20 left of it, 16 below the agent (half the gap would be 50).
    expect(routed.map((item) => item.data?.trunk)).toEqual([{ x: -20, y: 116 }, { x: -20, y: 116 }])
  })

  it('runs one trunk down a column whose cards do not quite line up', () => {
    const nodes = [node('agent', card(0, 0)), node('a', card(12, 200)), node('b', card(0, 320))]
    const routed = assignPorts([edge('agent', 'a'), edge('agent', 'b')], nodes)
    expect(new Set(routed.map((item) => JSON.stringify(item.data?.trunk)))).toEqual(new Set([JSON.stringify({ x: -20, y: 116 })]))
  })

  it('drops to each card below when they are not one column', () => {
    const nodes = [node('agent', card(0, 0)), node('a', card(-200, 200)), node('b', card(200, 200))]
    const routed = assignPorts([edge('agent', 'a'), edge('agent', 'b')], nodes)
    expect(routed.every((item) => item.sourceHandle === PORT.down && item.targetHandle === PORT.top)).toBe(true)
  })

  it('leaves an edge alone when a card has not been sized yet', () => {
    const routed = assignPorts([edge('a', 'b')], [{ id: 'a', position: { x: 0, y: 0 }, data: {} }, node('b', card(400, 0))])
    expect(routed[0].sourceHandle).toBeUndefined()
  })
})

describe('the four points', () => {
  const box = card(100, 200, 240, 100)

  it('sit in the middle of the top and bottom, and at the name row on the left and right', () => {
    expect(portAt(box, null, 'target')).toEqual({ point: [100, 244], side: Position.Left })
    expect(portAt(box, null, 'source')).toEqual({ point: [340, 244], side: Position.Right })
    expect(portAt(box, PORT.top, 'target')).toEqual({ point: [220, 200], side: Position.Top })
    expect(portAt(box, PORT.topOut, 'source')).toEqual({ point: [220, 200], side: Position.Top })
    expect(portAt(box, PORT.down, 'source')).toEqual({ point: [220, 300], side: Position.Bottom })
    expect(portAt(box, PORT.bottomIn, 'target')).toEqual({ point: [220, 300], side: Position.Bottom })
    expect(portAt(box, PORT.leftOut, 'source')).toEqual({ point: [100, 244], side: Position.Left })
    expect(portAt(box, PORT.rightIn, 'target')).toEqual({ point: [340, 244], side: Position.Right })
  })

  it('give every pair the chooser picks a shape to draw, so no line falls back to a guess', () => {
    const pairs: [string | null, string | null][] = [[null, null], [PORT.down, PORT.top], [PORT.topOut, PORT.top], [PORT.down, PORT.bottomIn], [PORT.leftOut, PORT.rightIn], [PORT.topOut, PORT.bottomIn], [PORT.down, null]]
    for (const [sourceHandle, targetHandle] of pairs) {
      const from = portAt(card(0, 0), sourceHandle, 'source')
      const to = portAt(card(500, 400), targetHandle, 'target')
      expect(linePoints(from.point, from.side, to.point, to.side), `${sourceHandle} → ${targetHandle}`).not.toBeNull()
    }
  })
})
