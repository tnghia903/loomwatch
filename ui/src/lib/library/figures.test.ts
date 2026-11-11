import { describe, expect, it } from 'vitest'

import { ACCESSORIES, isQuestItem, migrateItem } from '../quests/catalog'
import { hashId } from '../story/mark'
import { agentFigure, BUILDS, FIGURE_COLORS, FIGURE_HUES, FIGURE_KINDS, STARTER_COLORS, figureFor, figureHue, figureStill, figureWords, freshFigure, isFigureChoice, migrateFigure, type FigureChoice, signFor, jobFigure, type FigureView } from './figures'

/** A figure as chosen, without the sign it is drawn with. */
const look = ({ sign: _sign, ...figure }: FigureView) => figure

describe('the figure an agent wears', () => {
  it('is the one chosen for it, or one its id picks, the same every time', () => {
    expect(figureFor('reader', { kind: 'little', color: 'rose' })).toEqual({ kind: 'little', color: 'rose' })
    expect(figureFor('reader')).toEqual(figureFor('reader'))
    // Any build can be picked, but only a colour everyone starts with: one a quest earns is chosen, never handed out.
    expect(FIGURE_KINDS).toEqual(BUILDS)
    expect(BUILDS).toContain(figureFor('reader').kind)
    expect(FIGURE_COLORS).toEqual([...STARTER_COLORS, 'plum', 'sunset'])
    expect(STARTER_COLORS).toContain(figureFor('reader').color)
    // A choice it does not know is not worn.
    expect(figureFor('reader', { kind: 'robot', color: 'sage' } as never)).toEqual(figureFor('reader'))
  })

  it('spreads agents with similar ids over different figures', () => {
    const worn = new Set(['writer', 'writer-2', 'reader', 'researcher', 'reviewer', 'editor'].map((id) => JSON.stringify(figureFor(id))))
    expect(worn.size).toBeGreaterThan(3)
  })

  it('knows the figures it can draw', () => {
    expect(isFigureChoice({ kind: 'slim', color: 'orchid' })).toBe(true)
    expect(isFigureChoice({ kind: 'tall', color: 'sunset', wear: ['beret', 'coffee'] })).toBe(true)
    expect(isFigureChoice({ kind: 'slim', color: 'orchid', wear: ['crown'] })).toBe(false)
    expect(isFigureChoice({ kind: 'slim', color: 'red' })).toBe(false)
    expect(isFigureChoice(null)).toBe(false)
    expect(figureStill({ kind: 'tall', color: 'lilac' })).toBe('/agent/figures/tall-lilac.webp')
    expect(figureWords({ kind: 'slim', color: 'orchid' })).toBe('orchid slim')
  })

  // Agents dressed by an earlier LoomWatch, under the sewing names, keep their look.
  it('is today’s names for a figure chosen under old ones', () => {
    expect(figureFor('reader', { kind: 'cone', color: 'oat', wear: ['monocle', 'tee'] } as never)).toEqual({ kind: 'slim', color: 'orchid', wear: ['beret', 'striped_top'] })
    expect(figureFor('reader', { kind: 'scissors', color: 'rose' } as never)).toEqual({ kind: 'slim', color: 'plum' })
    expect(figureFor('reader', { kind: 'spool', color: 'butter', wear: ['chalk'] } as never)).toEqual({ kind: 'tall', color: 'clay', wear: ['bow'] })
    // Saved by a team's agent's link, it is still worn under today's names.
    expect(look(agentFigure({ id: 'editor-2', from: { agent: 'editor', version: 3 } }, [{ id: 'editor', figure: { kind: 'bobbin', color: 'oat' } as never }]))).toEqual({ kind: 'tall', color: 'sunset' })
  })

  // An agent nobody dressed keeps its look: the build and colour picked now are the old pick's,
  // renamed, the same as figures.rs `an_agent_nobody_dressed_keeps_its_look`.
  it('is the old pick, renamed, for an agent nobody dressed', () => {
    const oldKinds = ['yarn', 'spool', 'button', 'thimble', 'pincushion', 'cone']
    const oldColors = ['clay', 'butter', 'sage', 'sky', 'lilac', 'rose', 'oat']
    for (const id of ['reader', 'writer', 'writer-2', 'researcher', 'reviewer', 'editor', 'a', '']) {
      const seed = hashId(id)
      const old = { kind: oldKinds[seed % 6], color: oldColors[Math.floor(seed / 6) % 7] }
      expect(figureFor(id), id).toEqual(migrateFigure(old))
    }
  })
})

describe('an old figure', () => {
  // The same cases as figures.rs `maps_every_old_figure_to_a_build_and_colour_that_exist`.
  it('maps every old figure', () => {
    const cases: [[string, string], [string, string]][] = [
      [['yarn', 'clay'], ['chubby', 'clay']],
      [['spool', 'butter'], ['tall', 'clay']],
      [['button', 'sage'], ['wide', 'sage']],
      [['thimble', 'sky'], ['little', 'sky']],
      [['pincushion', 'lilac'], ['egg', 'lilac']],
      [['cone', 'oat'], ['slim', 'orchid']],
      [['scissors', 'rose'], ['slim', 'plum']],
      [['bobbin', 'oat'], ['tall', 'sunset']],
      [['tall', 'orchid'], ['tall', 'orchid']],
      [['egg', 'sunset'], ['egg', 'sunset']],
    ]
    for (const [[kind, color], [wantKind, wantColor]] of cases) {
      const today = migrateFigure({ kind, color })
      expect(today, `${kind} ${color}`).toEqual({ kind: wantKind, color: wantColor })
      expect(isFigureChoice(today)).toBe(true)
    }
    expect(migrateFigure({ kind: 'teapot', color: 'mauve' })).toEqual({ kind: 'teapot', color: 'mauve' })
  })

  // The same cases as figures.rs `maps_every_old_wardrobe_item_to_one_that_rewards_the_same_quest`.
  it('maps every old wardrobe item to one that rewards the same quest', () => {
    const cases: [string, string][] = [
      ['tee', 'striped_top'],
      ['overalls', 'cardigan'],
      ['apron', 'black_dress'],
      ['vest', 'trench_coat'],
      ['chalk', 'bow'],
      ['band', 'coffee'],
      ['pin', 'gloves'],
      ['cushion', 'ballet_flats'],
      ['shuttle', 'silk_scarf'],
      ['monocle', 'beret'],
      ['patch', 'collar'],
      ['scissors', 'plum'],
      ['bobbin', 'sunset'],
      ['handbag', 'coffee'],
      ['pearls', 'collar'],
      ['sunglasses', 'beret'],
    ]
    for (const [old, today] of cases) {
      expect(migrateItem(old), old).toBe(today)
      expect(isQuestItem(today), today).toBe(true)
    }
    for (const item of ACCESSORIES) expect(migrateItem(item)).toBe(item)
    expect(migrateItem('crown')).toBe('crown')
  })
})

describe('a new agent’s figure', () => {
  it('is one none of your agents wears, a new shape before a new colour', () => {
    const worn: FigureChoice[] = BUILDS.slice(0, 5).map((kind) => ({ kind, color: 'clay' }))
    expect(freshFigure('new', worn).kind).toBe('slim')
    const all: FigureChoice[] = BUILDS.map((kind) => ({ kind, color: 'clay' }))
    const next = freshFigure('new', all)
    expect(all.some((figure) => figure.kind === next.kind && figure.color === next.color)).toBe(false)
  })

  it('repeats one only when every pairing is taken', () => {
    const every = BUILDS.flatMap((kind) => STARTER_COLORS.map((color) => ({ kind, color })))
    expect(freshFigure('new', every)).toEqual(figureFor('new'))
  })
})

describe('a team’s agent wears', () => {
  const saved = [{ id: 'editor', figure: { kind: 'little' as const, color: 'lilac' as const } }, { id: 'reader' }]
  it('its saved agent’s figure, found by its link and not by its id in the team', () => {
    expect(look(agentFigure({ id: 'editor-2', from: { agent: 'editor', version: 3 } }, saved))).toEqual({ kind: 'little', color: 'lilac' })
    // A saved agent with no figure chosen wears the one its own id picks, as on Home.
    expect(look(agentFigure({ id: 'reader-2', from: { agent: 'reader', version: 1 } }, saved))).toEqual(figureFor('reader'))
  })

  it('the one its id picks when it is the team’s own', () => {
    expect(look(agentFigure({ id: 'writer' }, saved))).toEqual(figureFor('writer'))
  })

  // The owner (2026-10-26): Cole wore a lilac spool in My agents and another figure on the screen a
  // run of its chat opened on. Its chat file names no link, so the chat it is says whose it is.
  it('in an agent’s own chat, the figure of the agent the chat is for', () => {
    expect(figureFor('editor')).not.toEqual({ kind: 'little', color: 'lilac' })
    expect(look(agentFigure({ id: 'editor' }, saved, 'editor'))).toEqual({ kind: 'little', color: 'lilac' })
    // A chat for an agent not in My agents wears the one the chat's name picks, as before.
    expect(look(agentFigure({ id: 'new-editor' }, saved, 'new-editor'))).toEqual(figureFor('new-editor'))
    // A link still wins.
    expect(look(agentFigure({ id: 'editor-2', from: { agent: 'reader', version: 1 } }, saved, 'editor'))).toEqual(figureFor('reader'))
  })
})

describe('an agent’s chat colour', () => {
  it('is its figure’s colour, one to eight; zero stays yours', () => {
    expect(figureHue({ kind: 'chubby', color: 'clay' })).toBe(1)
    expect(figureHue({ kind: 'slim', color: 'sunset' })).toBe(FIGURE_HUES)
    expect(FIGURE_HUES).toBe(8)
    expect(new Set(FIGURE_COLORS.map((color) => figureHue({ kind: 'chubby', color }))).size).toBe(FIGURE_HUES)
  })
})

describe('the sign on a figure’s head', () => {
  it('is its saved agent’s job icon, else what its name suggests, else a plain curl', () => {
    expect(signFor({ icon: 'review', name: 'Ada' })).toBe('review')
    expect(signFor({ name: 'Trip writer' })).toBe('write')
    expect(signFor({ name: 'Ada', instructions: 'Analyse the sales data.' })).toBe('analyse')
    expect(signFor({ name: 'Ada' })).toBe('curl')
    // An icon that is no job's is not a sign.
    expect(signFor({ icon: 'crown', name: 'Ada' })).toBe('curl')
  })
  it('comes from the agent, never from the figure picked for it', () => {
    const figure = { kind: 'egg' as const, color: 'sage' as const }
    expect(jobFigure({ id: 'a', figure, icon: 'code' })).toEqual({ ...figure, sign: 'code' })
    expect(jobFigure({ id: 'b', figure, icon: 'design' })).toEqual({ ...figure, sign: 'design' })
    expect(agentFigure({ id: 'researcher', name: 'Researcher' }, []).sign).toBe('research')
    expect(agentFigure({ id: 'r-2', from: { agent: 'mine', version: 1 } }, [{ id: 'mine', icon: 'video' }]).sign).toBe('video')
  })
})
