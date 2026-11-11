import type { FigureColor } from './figures'

/** Each colour's swatch: the body's own mid-tone as the stills render it. Its own module, with nothing
    of the app's, so the landing page's figures (site/crewScene.ts) take only this. */
export const COLOR_HEX: Record<FigureColor, string> = {
  clay: '#C3693F',
  sage: '#6A8F6A',
  sky: '#5C8BB2',
  lilac: '#8576C7',
  rose: '#BB687F',
  orchid: '#AA67BC',
  plum: '#6B2F62',
  sunset: '#9E3A6A',
}

/**
 * The colour the live 3D figure's velvet is painted (the bench, the landing page's crew and cord), so
 * that lit as they are, under the pile furCoat lays on it, its median colour matches its still's:
 * within ΔE 1 on the tall build, and about 4 on the others. Measured by rendering each colour and
 * correcting it until they agreed, rather than painting the swatch colour
 * (COLOR_HEX), which the lights and the sheen lift into a much louder colour than the stills show.
 */
export const LIVE_HEX: Record<FigureColor, string> = {
  clay: '#B57556',
  sage: '#79957F',
  sky: '#7092AE',
  lilac: '#8183B4',
  rose: '#AB798A',
  orchid: '#9B7EB1',
  plum: '#814A82',
  sunset: '#A05687',
}
