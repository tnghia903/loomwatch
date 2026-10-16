import { describe, expect, it } from 'vitest'

import { agentFigure, FIGURE_COLORS, FIGURE_HUES, FIGURE_KINDS, STARTER_KINDS, figureFor, figureHue, figureStill, figureWords, freshFigure, isFigureChoice, type FigureChoice } from './figures'

describe('the figure an agent wears', () => {
  it('is the one chosen for it, or one its id picks, the same every time', () => {
    expect(figureFor('reader', { kind: 'thimble', color: 'rose' })).toEqual({ kind: 'thimble', color: 'rose' })
    expect(figureFor('reader')).toEqual(figureFor('reader'))
    // Only a figure everyone starts with is picked: one a quest earns is chosen, never handed out.
    expect(STARTER_KINDS).toContain(figureFor('reader').kind)
    expect(FIGURE_KINDS).toEqual([...STARTER_KINDS, 'scissors', 'bobbin'])
    expect(FIGURE_COLORS).toContain(figureFor('reader').color)
    // A choice it does not know is not worn.
    expect(figureFor('reader', { kind: 'robot', color: 'sage' } as never)).toEqual(figureFor('reader'))
  })

  it('spreads agents with similar ids over different figures', () => {
    const worn = new Set(['writer', 'writer-2', 'reader', 'researcher', 'reviewer', 'editor'].map((id) => JSON.stringify(figureFor(id))))
    expect(worn.size).toBeGreaterThan(3)
  })

  it('knows the figures it can draw', () => {
    expect(isFigureChoice({ kind: 'cone', color: 'oat' })).toBe(true)
    expect(isFigureChoice({ kind: 'bobbin', color: 'oat', wear: ['monocle', 'band'] })).toBe(true)
    expect(isFigureChoice({ kind: 'cone', color: 'oat', wear: ['crown'] })).toBe(false)
    expect(isFigureChoice({ kind: 'cone', color: 'red' })).toBe(false)
    expect(isFigureChoice(null)).toBe(false)
    expect(figureStill({ kind: 'cone', color: 'oat' })).toBe('/agent/figures/cone-oat.webp')
    expect(figureWords({ kind: 'cone', color: 'oat' })).toBe('oat thread cone')
  })
})

describe('a new agent’s figure', () => {
  it('is one none of your agents wears, a new shape before a new colour', () => {
    const worn: FigureChoice[] = STARTER_KINDS.slice(0, 5).map((kind) => ({ kind, color: 'clay' }))
    expect(freshFigure('new', worn).kind).toBe('cone')
    const all: FigureChoice[] = STARTER_KINDS.map((kind) => ({ kind, color: 'clay' }))
    const next = freshFigure('new', all)
    expect(all.some((figure) => figure.kind === next.kind && figure.color === next.color)).toBe(false)
  })

  it('repeats one only when every pairing is taken', () => {
    const every = STARTER_KINDS.flatMap((kind) => FIGURE_COLORS.map((color) => ({ kind, color })))
    expect(freshFigure('new', every)).toEqual(figureFor('new'))
  })
})

describe('a team’s agent wears', () => {
  const saved = [{ id: 'editor', figure: { kind: 'thimble' as const, color: 'lilac' as const } }, { id: 'reader' }]
  it('its saved agent’s figure, found by its link and not by its id in the team', () => {
    expect(agentFigure({ id: 'editor-2', from: { agent: 'editor', version: 3 } }, saved)).toEqual({ kind: 'thimble', color: 'lilac' })
    // A saved agent with no figure chosen wears the one its own id picks, as on Home.
    expect(agentFigure({ id: 'reader-2', from: { agent: 'reader', version: 1 } }, saved)).toEqual(figureFor('reader'))
  })

  it('the one its id picks when it is the team’s own', () => {
    expect(agentFigure({ id: 'writer' }, saved)).toEqual(figureFor('writer'))
  })
})

describe('an agent’s chat colour', () => {
  it('is its figure’s colour, one to seven; zero stays yours', () => {
    expect(figureHue({ kind: 'yarn', color: 'clay' })).toBe(1)
    expect(figureHue({ kind: 'cone', color: 'oat' })).toBe(FIGURE_HUES)
    expect(new Set(FIGURE_COLORS.map((color) => figureHue({ kind: 'yarn', color }))).size).toBe(FIGURE_HUES)
  })
})

