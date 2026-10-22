import { describe, expect, it } from 'vitest'

import { apcaLc, tokenColour, wcagRatio } from './contrast'

// The tests that ask "does this read?" trust these numbers, so they are held to APCA's and WCAG's
// own reference pairs, and to the ratios DESIGN_LANGUAGE §4 prints for the tokens.
describe('the contrast the tests measure', () => {
  it('gives APCA’s reference values, negative for light text on dark', () => {
    expect(apcaLc('#888888', '#FFFFFF')).toBeCloseTo(63.06, 1)
    expect(apcaLc('#FFFFFF', '#888888')).toBeCloseTo(-68.54, 1)
    expect(apcaLc('#000000', '#FFFFFF')).toBeCloseTo(106.04, 1)
    expect(apcaLc('#FFFFFF', '#000000')).toBeCloseTo(-107.88, 1)
    expect(apcaLc('#777777', '#777777')).toBe(0)
  })

  it('gives WCAG 2’s ratio either way round', () => {
    expect(wcagRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(wcagRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(wcagRatio('#777777', '#777777')).toBe(1)
  })

  it('reads a token in each theme, through its primitive, as the app ships it', () => {
    expect(tokenColour('var(--color-alert)', 'light')).toBe('#C0342E')
    expect(tokenColour('var(--color-alert)', 'dark')).toBe('#F2635C')
    // Dark sets only what differs; a component alias resolves to each theme's own colour.
    expect(tokenColour('var(--lw-node-fill)', 'dark')).toBe('#131316')
    expect(tokenColour('var(--lw-node-fill)', 'light')).toBe('#FFFFFF')
    // The red on the dark card: 5.9:1, which passes, but APCA Lc 44, the muddy pair.
    const [red, card] = [tokenColour('var(--color-alert)', 'dark'), tokenColour('var(--color-panel-solid)', 'dark')]
    expect(wcagRatio(red, card)).toBeCloseTo(5.93, 2)
    expect(apcaLc(red, card)).toBeCloseTo(-43.6, 1)
  })

  it('reads a token on an element as the browser inherits it, the dark shell’s own colours too', () => {
    const shell = document.body.appendChild(document.createElement('div'))
    const card = shell.appendChild(document.createElement('div'))
    const theme = document.documentElement.getAttribute('data-theme')
    try {
      expect(tokenColour('var(--color-panel-solid)', 'dark', card)).toBe('#131316')
      shell.className = 'lw-shell'
      expect(tokenColour('var(--color-panel-solid)', 'dark', card)).toBe('#17191C')
      expect(tokenColour('var(--color-panel-solid)', 'light', card)).toBe('#FFFFFF')
      // An alias set at the root keeps the root's colour: the shell's comes after it.
      expect(tokenColour('var(--lw-node-fill)', 'dark', card)).toBe('#131316')
      // The theme is put back as it was.
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
    } finally {
      shell.remove()
    }
  })

  it('refuses a value that is not one solid colour', () => {
    expect(() => tokenColour('var(--color-hairline)', 'dark')).toThrow(/not one solid colour/)
    expect(() => tokenColour('var(--no-such-token)', 'light')).toThrow(/not one solid colour/)
    expect(() => tokenColour(null, 'light')).toThrow(/not one solid colour/)
  })
})
