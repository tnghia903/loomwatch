import { describe, expect, it } from 'vitest'

import { apcaLc, THEMES, tokenColour, wcagRatio } from '../../test/contrast'

// A part asked about in a file has a bubble after its words, washed with the marker's gold in the
// lightness of the page under it, and an answer beside it on the screen's panel washed the same way
// (reader.css .rd-bubble, .rd-answer). Their marks are the
// only way some states are told apart, so each must stand out from its ground.
describe('the colours of a part asked about and its answer', () => {
  it.each(['light', 'dark'])('a bubble’s face, dots, gold dot, glows and cross read on it, on a %s page whatever the theme', (lightness) => {
    const bubble = tokenColour(`var(--color-bubble-${lightness})`, 'light')
    expect(tokenColour(`var(--color-bubble-${lightness})`, 'dark')).toBe(bubble)
    expect(wcagRatio(tokenColour(`var(--color-bubble-${lightness}-ink)`, 'light'), bubble)).toBeGreaterThanOrEqual(7)
    expect(wcagRatio(tokenColour(`var(--color-bubble-${lightness}-ink-2)`, 'light'), bubble)).toBeGreaterThanOrEqual(4.5)
    for (const mark of ['gold', 'live', 'alert']) {
      expect(wcagRatio(tokenColour(`var(--color-bubble-${lightness}-${mark})`, 'light'), bubble), mark).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(THEMES)('an answer’s words, focus ring and glows read on its gold-washed panel (%s)', (theme) => {
    const panel = tokenColour('var(--color-accent-tint)', theme)
    const words = tokenColour('var(--color-ink)', theme)
    expect(wcagRatio(words, panel)).toBeGreaterThanOrEqual(7)
    expect(Math.abs(apcaLc(words, panel))).toBeGreaterThanOrEqual(90)
    // What you asked, its state and notes are ink-2: still words to read.
    expect(wcagRatio(tokenColour('var(--color-ink-2)', theme), panel)).toBeGreaterThanOrEqual(4.5)
    // The focus ring and links are the accent; the face's glow is blue, gold or red.
    for (const mark of ['--color-accent', '--color-live', '--color-accent-fill', '--color-alert']) {
      expect(wcagRatio(tokenColour(`var(${mark})`, theme), panel), mark).toBeGreaterThanOrEqual(3)
    }
  })
})
