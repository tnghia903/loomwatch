import { describe, expect, it } from 'vitest'
import { organizePipeline } from './organize'

describe('organize pipeline', () => {
  it('keeps the execution spine straight and places resources below their owner', () => {
    const result = organizePipeline([{ id: 'writer' }, { id: 'researcher' }], [{ from: 'researcher', to: 'writer' }], [{ id: 'skill' }, { id: 'source' }], [{ from: 'researcher', to: 'source' }, { from: 'researcher', to: 'skill' }])
    expect(result.writer.x).toBeGreaterThan(result.researcher.x + 280)
    expect(result.writer.y).toBe(result.researcher.y)
    expect(result.skill.x).toBe(result.researcher.x)
    expect(result.source.x).toBe(result.researcher.x)
    expect(result.skill.y).toBeGreaterThan(result.researcher.y + 150)
    expect(Math.abs(result.skill.y - result.source.y)).toBeGreaterThanOrEqual(120)
  })

  it('keeps a diamond, large cards, shared resources and unconnected cards collision-free', () => {
    const agents = [{ id: 'start', width: 340, height: 230 }, { id: 'a' }, { id: 'b', height: 260 }, { id: 'end' }]
    const steps = [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' }, { from: 'a', to: 'end' }, { from: 'b', to: 'end' }]
    const resources = [{ id: 'shared', width: 420, height: 210 }, { id: 'extra', height: 180 }, { id: 'unwired' }]
    const wiring = [{ from: 'a', to: 'shared' }, { from: 'b', to: 'shared' }, { from: 'b', to: 'extra' }]
    const positions = organizePipeline(agents, steps, resources, wiring)
    expect(organizePipeline([...agents].reverse(), [...steps].reverse(), [...resources].reverse(), [...wiring].reverse())).toEqual(positions)
    for (const { from, to } of steps) expect(positions[to].x).toBeGreaterThan(positions[from].x)
    const cards = [...agents, ...resources]
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j], ap = positions[a.id], bp = positions[b.id]
      const overlap = ap.x < bp.x + (b.width ?? 280) && bp.x < ap.x + (a.width ?? 280)
        && ap.y < bp.y + (b.height ?? 150) && bp.y < ap.y + (a.height ?? 150)
      expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false)
    }
  })

  it('handles an empty or edge-free team and ignores dangling links', () => {
    expect(organizePipeline([], [], [], [])).toEqual({})
    const result = organizePipeline([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'gone' }], [{ id: 'source' }], [{ from: 'gone', to: 'source' }])
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'source'])
    expect(result.a.y).not.toBe(result.b.y)
    expect(result.source.y).toBeGreaterThan(Math.max(result.a.y, result.b.y) + 150)
  })
})
