import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { linkOf, markLinked } from './linked'

const node = (id: string, selected = false): Node => ({ id, position: { x: 0, y: 0 }, data: {}, selected })
const marker = { type: MarkerType.ArrowClosed, color: 'var(--color-warp)', width: 14, height: 14 }
const edge = (source: string, target: string, className?: string): Edge => ({ id: `${source}->${target}`, source, target, className, markerEnd: marker, data: { label: 'hands off' } })

// researcher → checker → writer, and the researcher reads a folder.
const edges = [edge('researcher', 'checker'), edge('checker', 'writer'), edge('researcher', 'folder', 'resource')]

describe('markLinked', () => {
  it('changes nothing while no card is selected', () => {
    const nodes = [node('researcher'), node('checker'), node('writer'), node('folder')]
    const marked = markLinked(nodes, edges)
    expect(marked.nodes).toBe(nodes)
    expect(marked.edges).toBe(edges)
  })

  it("brings a selected card's lines in and out forward, drawn last, and steps the others back", () => {
    const marked = markLinked([node('researcher'), node('checker', true), node('writer'), node('folder')], edges)
    // Drawn in this order, so where lines cross the selected card's lie on top.
    expect(marked.edges.map((item) => [item.id, linkOf(item.data)])).toEqual([
      ['researcher->folder', 'faded'],
      ['researcher->checker', 'linked'],
      ['checker->writer', 'linked'],
    ])
    expect(marked.edges[1].className).toBe('linked')
    // A line's own classes stay; the mark is added.
    expect(marked.edges[0].className).toBe('resource faded')
    // Its words and the rest of its data come along.
    expect(marked.edges[1].data).toEqual({ label: 'hands off', link: 'linked' })
  })

  it('draws a lit line’s arrowhead in gold, and leaves the others’ as they were', () => {
    const marked = markLinked([node('researcher'), node('checker', true), node('writer'), node('folder')], edges)
    expect(marked.edges[1].markerEnd).toEqual({ ...marker, color: 'var(--color-accent)' })
    expect(marked.edges[0].markerEnd).toBe(marker)
  })

  it('steps back only the cards with no line to the selected card, and keeps the rest as they were', () => {
    const nodes = [node('researcher'), node('checker', true), node('writer'), node('folder')]
    const marked = markLinked(nodes, edges)
    // The folder hangs off the researcher, not the checker, so only it goes out of focus.
    expect(marked.nodes.map((item) => item.className)).toEqual([undefined, undefined, undefined, 'faded'])
    marked.nodes.slice(0, 3).forEach((item, i) => expect(item).toBe(nodes[i]))
  })

  it('lights every line of every selected card', () => {
    const marked = markLinked([node('researcher', true), node('checker'), node('writer', true), node('folder')], edges)
    expect(marked.edges.every((item) => linkOf(item.data) === 'linked')).toBe(true)
    expect(marked.nodes.every((item) => item.className === undefined)).toBe(true)
  })
})
