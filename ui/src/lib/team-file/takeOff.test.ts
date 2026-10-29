import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { TeamFileModel } from './document'
import { takeAgentOff } from './takeOff'
import type { TeamDocument } from './types'

const TS = '2026-10-29T00:00:00Z'
/** A team file: agents by id (`?` marks a review stop), the line as `a>b` pairs, who starts and who replies. */
function team(agents: string, line: string, entrypoint: string, responder?: string): TeamFileModel {
  const cards = agents.split(' ').map((id) => (id.endsWith('?') ? `  - {id: ${id.slice(0, -1)}, kind: operator, role: Check it.}` : `  - {id: ${id}, model: fake/offline, role: Work.}`))
  const edges = line ? line.split(' ').map((pair) => { const [from, to] = pair.split('>'); return `  - {from: ${from}, to: ${to}, layer: configured, kind: sequence, ts: "${TS}"}` }) : []
  return TeamFileModel.parse(`schemaVersion: 1\n# Mine.\nid: t\nname: T\nentrypoint: ${entrypoint}\n${responder ? `responder: ${responder}\n` : ''}agents:\n${cards.join('\n')}\nedges:${edges.length ? `\n${edges.join('\n')}` : ' []'}\n`)
}
const read = (model: TeamFileModel) => parse(model.toYaml()) as TeamDocument
const line = (model: TeamFileModel) => (read(model).edges ?? []).map((edge) => `${edge.from}>${edge.to}`).join(' ')

describe('Taking an agent off a team so it still runs (ADR 0100)', () => {
  it('closes up the line around one in the middle', () => {
    const model = team('a x b c', 'a>x x>b b>c', 'a')
    expect(takeAgentOff(model, ['x'])).toEqual({ stopsGone: [] })
    expect(line(model)).toBe('b>c a>b')
    expect(read(model).entrypoint).toBe('a')
    expect(model.toYaml()).toContain('# Mine.')
  })

  it('joins every one before it to every one after it', () => {
    const model = team('a b x c d', 'a>x b>x x>c x>d a>b', 'a')
    takeAgentOff(model, ['x'])
    expect(line(model).split(' ').sort()).toEqual(['a>b', 'a>c', 'a>d', 'b>c', 'b>d'])
  })

  it('lets the next one start when it started the team', () => {
    const model = team('x b c', 'x>b b>c', 'x')
    expect(takeAgentOff(model, ['x'])).toEqual({ stopsGone: [], startsInstead: 'b' })
    expect(read(model).entrypoint).toBe('b')
    expect(line(model)).toBe('b>c')
  })

  it('takes a review stop left at the front with it, since there is no work before it to check', () => {
    const model = team('x you? w', 'x>you you>w', 'x')
    expect(takeAgentOff(model, ['x'])).toEqual({ stopsGone: ['you'], startsInstead: 'w' })
    expect(read(model).agents.map((agent) => agent.id)).toEqual(['w'])
    expect(read(model).entrypoint).toBe('w')
  })

  it('asks who starts when it handed work to several, or led a team of several with no line', () => {
    expect(takeAgentOff(team('x b c', 'x>b x>c', 'x'), ['x'])).toEqual({ stopsGone: [], chooseStart: ['b', 'c'] })
    expect(takeAgentOff(team('x b c', '', 'x'), ['x'])).toEqual({ stopsGone: [], chooseStart: ['b', 'c'] })
    expect(takeAgentOff(team('x b', '', 'x'), ['x'])).toEqual({ stopsGone: [], startsInstead: 'b' })
    // Only one is left at the front when the other gets its work from it.
    expect(takeAgentOff(team('x b c', 'x>b x>c c>b', 'x'), ['x'])).toEqual({ stopsGone: [], startsInstead: 'c' })
  })

  it('starts with the one picked, which hands the work on to the others at the front', () => {
    const model = team('x b c d', 'x>b x>c c>d', 'x')
    expect(takeAgentOff(model, ['x'], 'c')).toEqual({ stopsGone: [], startsInstead: 'c' })
    expect(read(model).entrypoint).toBe('c')
    expect(line(model).split(' ').sort()).toEqual(['c>b', 'c>d'])
    const lead = team('x b c', '', 'x')
    takeAgentOff(lead, ['x'], 'c')
    expect(read(lead).entrypoint).toBe('c')
    expect(read(lead).edges).toEqual([])
  })

  it('says a team with no agent left is empty', () => {
    expect(takeAgentOff(team('x', '', 'x'), ['x'])).toMatchObject({ empty: true })
    expect(takeAgentOff(team('x you?', 'x>you', 'x'), ['x'])).toMatchObject({ empty: true })
  })

  it('keeps who replies, unless it went, and the starting agent replies once no line is left', () => {
    const kept = team('a x b', 'a>x x>b', 'a', 'b')
    takeAgentOff(kept, ['x'])
    expect(read(kept).responder).toBe('b')
    const went = team('a b x', 'a>b b>x', 'a', 'x')
    takeAgentOff(went, ['x'])
    expect(read(went)).not.toHaveProperty('responder')
    const alone = team('a x', 'a>x', 'a', 'x')
    takeAgentOff(alone, ['x'])
    expect(read(alone).responder).toBe('a')
  })
})
