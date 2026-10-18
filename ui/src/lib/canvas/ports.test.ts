import { Position, type Edge, type Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { assignPorts, cardEdgePoint, choosePorts, PORT, type Box } from './ports'

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

  it('bridges back to a card on the left, rather than curving through the row', () => {
    expect(choosePorts(card(400, 0), card(0, 0), [], false)).toEqual({ sourceHandle: PORT.bridgeOut, targetHandle: PORT.bridgeIn })
  })

  it('bridges over a card standing in the relay’s way', () => {
    expect(choosePorts(card(0, 0), card(800, 0), [card(400, 0)], false)).toEqual({ sourceHandle: PORT.bridgeOut, targetHandle: PORT.bridgeIn })
  })

  it('goes under when going over would cross a card too', () => {
    const between = card(400, 0)
    const above = card(300, -170, 600, 60)
    expect(choosePorts(card(0, 0), card(800, 0), [between, above], false)).toEqual({ sourceHandle: PORT.underOut, targetHandle: PORT.underIn })
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
    expect(routed.map((item) => [item.sourceHandle, item.targetHandle])).toEqual([[PORT.trunk, null], [PORT.trunk, null]])
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

describe('cardEdgePoint', () => {
  const card = { x: 400, y: 300, width: 200, height: 80 } // centre (500, 340)

  it('meets the side that faces where the line comes from', () => {
    expect(cardEdgePoint({ x: 100, y: 340 }, card)).toEqual({ x: 400, y: 340, position: Position.Left })
    expect(cardEdgePoint({ x: 900, y: 340 }, card)).toEqual({ x: 600, y: 340, position: Position.Right })
    expect(cardEdgePoint({ x: 500, y: 0 }, card)).toEqual({ x: 500, y: 300, position: Position.Top })
    expect(cardEdgePoint({ x: 500, y: 700 }, card)).toEqual({ x: 500, y: 380, position: Position.Bottom })
  })

  it('aims at the centre, so a line from above and to the left lands on the edge on that diagonal', () => {
    // From (300, 240): the line to the centre crosses x = 400 at y = 290, above the card, so it
    // enters by the top, at y = 300 and x = 500 - 200 * (40 / 100) = 420.
    const point = cardEdgePoint({ x: 300, y: 240 }, card)
    expect(point.position).toBe(Position.Top)
    expect(point.y).toBeCloseTo(300)
    expect(point.x).toBeCloseTo(420)
  })

  it('still ends on the edge when the line starts inside the card', () => {
    expect(cardEdgePoint({ x: 450, y: 340 }, card)).toEqual({ x: 400, y: 340, position: Position.Left })
    expect(cardEdgePoint({ x: 500, y: 340 }, card)).toEqual({ x: 400, y: 340, position: Position.Left })
  })
})
