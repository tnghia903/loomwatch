import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { background, cascaded } from '../../test/cascade'
import { apcaLc, THEMES, tokenColour, wcagRatio, type Theme } from '../../test/contrast'
import { FIGURE_HUES } from '../../lib/library/figures'
import { BatonPill } from './BatonPill'

afterEach(cleanup)

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))

/** A colour the stylesheet sets, as `#RRGGBB`: a token, or a `color-mix(in srgb, …)` of two, as the browser mixes it. */
function solid(value: string, theme: Theme, on: Element): string {
  const mixed = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(value)
  if (!mixed) return tokenColour(value, theme, on)
  const share = Number(mixed[2]) / 100
  const [one, other] = [mixed[1], mixed[3]].map((part) => channels(tokenColour(part, theme, on)))
  return `#${one.map((channel, at) => Math.round(channel * share + other[at] * (1 - share)).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/** What an element's words are drawn in, inherited from the nearest box that sets it. */
function inkOf(element: Element): [string, Element] {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const value = cascaded(at, 'color')
    if (value) return [value, at]
  }
  throw new Error('nothing sets the words’ colour')
}

/** What an element's words sit on: the nearest box with a fill of its own. */
function fillOf(element: Element): [string, Element] {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const value = background(at)
    if (value && !/^(none|transparent)$/.test(value)) return [value, at]
  }
  throw new Error('nothing under the words has a fill')
}

describe('the pill in the chat’s header that says who has the work', () => {
  // 2026-11-03: "needs you" measured 4.21:1 in light, gold words on the gold tint, and so did every
  // agent whose colour is sage (4.21:1) or butter (4.41:1): each agent's colour reads on the plain
  // panel, but not on its own 14% tint. The words are now that colour taken halfway to ink, and ink
  // on the gold tint, where gold words never go.
  it('says it in words that read on its tint, for every agent’s colour and while one waits on you, in both themes', () => {
    const pills = [...Array.from({ length: FIGURE_HUES + 1 }, (_, hue) => ({ hue, waiting: false })), { hue: 3, waiting: true }]
    const shells = ['', 'lw-shell', 'lw-railed']
    for (const { hue, waiting } of pills) {
      const { container, unmount } = render(<BatonPill words={waiting ? 'needs you' : 'Asking Researcher…'} hue={hue} waiting={waiting} />)
      const words = screen.getByText(waiting ? 'needs you' : 'Asking Researcher…')
      const [ink, inked] = inkOf(words)
      const [fill, filled] = fillOf(words)
      expect(filled).toHaveClass('tc-baton', 'on')
      if (waiting) expect(ink).toBe('var(--color-ink)')
      for (const shell of shells) {
        container.className = shell
        for (const theme of THEMES) {
          const [text, under] = [solid(ink, theme, inked), solid(fill, theme, filled)]
          const at = `hue ${hue}${waiting ? ', waiting' : ''}, ${shell || 'no shell'}, ${theme}: ${text} on ${under}`
          expect(wcagRatio(text, under), at).toBeGreaterThanOrEqual(4.5)
          expect(Math.abs(apcaLc(text, under)), at).toBeGreaterThanOrEqual(75)
        }
      }
      unmount()
    }
  })

  it('keeps each agent’s own colour in its words, its edge and its tint, and gold while one waits on you', () => {
    const { container, rerender } = render(<BatonPill words="Asking Researcher…" hue={3} waiting={false} />)
    const pill = container.querySelector('.tc-baton')!
    const hue = (theme: Theme) => tokenColour('var(--hue)', theme, pill)
    const [ink] = inkOf(screen.getByText('Asking Researcher…'))
    expect(ink).toMatch(/^color-mix\(in srgb, var\(--hue\) \d+%, var\(--color-ink\)\)$/)
    expect(fillOf(pill)[0]).toMatch(/var\(--hue\)/)
    for (const theme of THEMES) expect(hue(theme)).toBe(tokenColour('var(--color-fig-sky)', theme, pill))
    rerender(<BatonPill words="needs you" hue={3} waiting />)
    for (const theme of THEMES) expect(hue(theme)).toBe(tokenColour('var(--color-accent)', theme, pill))
  })
})
