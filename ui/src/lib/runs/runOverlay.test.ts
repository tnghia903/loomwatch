// TNG89_INTERACTION.md §15 acceptance rows 40–43.
//
// This file replaces `storyLayout.test.ts`. Two of that file's three cases pinned the causal
// column §15 retires — "keeps a forty-event agent to two rows" and "moves only an overridden
// agent … while keeping story anchors stable" both asserted a layout function that positioned
// every agent, which no longer exists: agents are at `doc.nodes` positions in every state. Its
// first case, the evidence fold, is kept verbatim below because that contract did not change.
import { describe, expect, it } from 'vitest'

import { causalOrder, DOCK, dockAnchors, fanEvidence, helperPositions, historicalRunPositions, visibleEvidence } from './runOverlay'

describe('the fold', () => {
  it('shows up to eight cards per agent and folds the rest into one overflow slot', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `e${index}`)
    expect(visibleEvidence(ids.slice(0, 8))).toEqual({ shown: ids.slice(0, 8), hidden: 0 })
    expect(visibleEvidence(ids)).toEqual({ shown: ids.slice(0, 7), hidden: 23 })
  })

  it('folding is a disclosure with a count, so the hidden cards are still counted (row 43)', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `e${index}`)
    const { shown, hidden } = visibleEvidence(ids)
    expect(shown.length + hidden).toBe(ids.length)
  })
})

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

  it('keeps the Run card under the Prompt and the schedule card above it, in one dock column', () => {
    const anchors = dockAnchors({ x: 0, y: 0 }, { x: 600, y: 0 })
    expect(anchors.run.x).toBe(anchors.prompt.x)
    expect(anchors.schedule.x).toBe(anchors.prompt.x)
    expect(anchors.run.y).toBeGreaterThanOrEqual(anchors.prompt.y + DOCK.promptH + 32)
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

describe('the evidence fan', () => {
  it('derives every card from its agent, so the fan cannot displace a configured node (row 40)', () => {
    const ids = ['a', 'b', 'c']
    const base = fanEvidence({ x: 100, y: 100 }, ids)
    const moved = fanEvidence({ x: 340, y: 180 }, ids)

    for (const id of ids) {
      expect(moved.shown[id]).toEqual({ x: base.shown[id].x + 240, y: base.shown[id].y + 80 })
      // Every card sits below its agent card, clear of the left-to-right spine.
      expect(base.shown[id].y).toBeGreaterThan(100)
    }
  })

  it('puts the overflow card after the visible ones, and only when there is overflow', () => {
    expect(fanEvidence({ x: 0, y: 0 }, ['one']).more).toBeNull()
    const ids = Array.from({ length: 40 }, (_, index) => `e${index}`)
    const fan = fanEvidence({ x: 0, y: 0 }, ids)
    expect(Object.keys(fan.shown)).toHaveLength(DOCK.maxVisible - 1)
    expect(fan.more?.hidden).toBe(40 - (DOCK.maxVisible - 1))
    expect(fan.more!.y).toBeGreaterThanOrEqual(fan.shown.e0.y)
    expect(fan.shown.e39).toBeUndefined()
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
