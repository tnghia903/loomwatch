// TNG89_INTERACTION.md §15 acceptance rows 40–42.
import { describe, expect, it } from 'vitest'

import { causalOrder, DOCK, dockAnchors, helperPositions, historicalRunPositions } from './runOverlay'

describe('the docked anchors', () => {
  it('docks the Prompt left of the entrypoint and the Output right of the terminal stage (row 42)', () => {
    const entry = { x: 400, y: 120 }
    const terminal = { x: 1200, y: 260 }
    const anchors = dockAnchors(entry, terminal)

    expect(anchors.prompt.x + DOCK.promptW).toBeLessThan(entry.x)
    expect(anchors.prompt).toEqual({ x: entry.x - DOCK.gap, y: entry.y })
    expect(anchors.output).toEqual({ x: terminal.x + DOCK.gap, y: terminal.y })
    // Left of the entrypoint and right of the terminal stage means the causal sentence reads
    // left to right on any auto-laid-out pipeline, without a column that re-stacks the agents.
    expect(anchors.prompt.x).toBeLessThan(entry.x)
    expect(anchors.output.x).toBeGreaterThan(terminal.x)
  })

  it('keeps the schedule card above the Prompt, in one dock column', () => {
    const anchors = dockAnchors({ x: 0, y: 0 }, { x: 600, y: 0 })
    expect(anchors.schedule.x).toBe(anchors.prompt.x)
    expect(anchors.schedule.y).toBeLessThan(anchors.prompt.y)
  })

  it('moves with the design rather than the design moving to it (row 40)', () => {
    const before = dockAnchors({ x: 0, y: 0 }, { x: 600, y: 0 })
    const after = dockAnchors({ x: 80, y: 40 }, { x: 680, y: 40 })
    expect(after.prompt).toEqual({ x: before.prompt.x + 80, y: before.prompt.y + 40 })
    expect(after.output).toEqual({ x: before.output.x + 80, y: before.output.y + 40 })
  })

  it('collapses both anchors onto the entrypoint in team mode, which has no terminal stage', () => {
    const entry = { x: 240, y: 60 }
    const anchors = dockAnchors(entry, entry)
    expect(anchors.prompt.x).toBe(entry.x - DOCK.gap)
    expect(anchors.output.x).toBe(entry.x + DOCK.gap)
  })
})

describe('run-time helpers with no configured node', () => {
  it('seeds them below the entrypoint, deterministically', () => {
    const anchor = { x: 200, y: 100 }
    const once = helperPositions(['helper-b', 'helper-a'], anchor)
    const twice = helperPositions(['helper-b', 'helper-a'], anchor)
    expect(once).toEqual(twice)
    expect(Object.keys(once).sort()).toEqual(['helper-a', 'helper-b'])
    for (const point of Object.values(once)) expect(point.y).toBeGreaterThan(anchor.y)
  })

  it('places nothing when every agent in the run has a node of its own', () => {
    expect(helperPositions([], { x: 0, y: 0 })).toEqual({})
  })
})

describe('historical run layout', () => {
  it('puts an archived lead before the current pipeline and keeps resources below their owner', () => {
    const positions = historicalRunPositions(
      [{ id: 'collector' }, { id: 'research' }, { id: 'report' }],
      [{ from: 'research', to: 'report' }],
      [{ id: 'source' }, { id: 'skill' }],
      [{ from: 'research', to: 'source' }, { from: 'report', to: 'skill' }],
      'collector',
      'research',
    )

    expect(positions.collector.x).toBeLessThan(positions.research.x)
    expect(positions.research.x).toBeLessThan(positions.report.x)
    expect(positions.collector.y).toBe(positions.research.y)
    expect(positions.research.y).toBe(positions.report.y)
    expect(positions.source.y).toBeGreaterThan(positions.research.y + 150)
    expect(positions.skill.y).toBeGreaterThan(positions.report.y + 150)
  })

  it('does not add a second constraint when the archived and configured leads match', () => {
    const positions = historicalRunPositions(
      [{ id: 'research' }, { id: 'report' }],
      [{ from: 'research', to: 'report' }],
      [],
      [],
      'research',
      'research',
    )
    expect(positions.report.x).toBeGreaterThan(positions.research.x)
    expect(positions.report.y).toBe(positions.research.y)
  })
})

describe('causal order', () => {
  it('is pipeline order when configured, lead first then first appearance otherwise', () => {
    expect(causalOrder(['a', 'b', 'c'], [{ id: 'c', firstSeq: 1 }, { id: 'a', firstSeq: 9 }], 'a')).toEqual(['a', 'b', 'c'])
    expect(causalOrder([], [{ id: 'z', firstSeq: 7 }, { id: 'y', firstSeq: 2 }], 'lead')).toEqual(['lead', 'y', 'z'])
  })
})
