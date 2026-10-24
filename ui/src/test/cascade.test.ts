import { describe, expect, it } from 'vitest'

import { cascaded, DESKTOP, mediaHolds, neededClasses, PHONE, rulesOf } from './cascade'

// The tests that ask "is this gold? is it 32 px?" trust this cascade, so it has to keep a phone's
// rules off a desktop, and the other way round, or a 44 px phone height would pass for 32.
describe('the stylesheet cascade the tests run', () => {
  it('applies a width rule only at the widths it names', () => {
    expect(mediaHolds('(max-width: 767px)', PHONE)).toBe(true)
    expect(mediaHolds('(max-width: 767px)', DESKTOP)).toBe(false)
    expect(mediaHolds('(min-width: 768px)', DESKTOP)).toBe(true)
    expect(mediaHolds('(min-width: 768px) and (max-width: 1179px)', DESKTOP)).toBe(false)
    expect(mediaHolds('(prefers-reduced-motion: reduce)', DESKTOP)).toBe(false)
    expect(mediaHolds('(prefers-reduced-motion: reduce)', { ...DESKTOP, reducedMotion: true })).toBe(true)
  })

  it('cascades a rule inside @media only where it holds, and by specificity, order and !important', () => {
    const rules = rulesOf(`
      .x { min-height: 32px; color: red }
      @media (max-width: 767px) { .x { min-height: 44px } }
      @keyframes spin { from { color: blue } }
      .y .x { color: green }
      .x { color: navy !important }
    `)
    const outer = document.createElement('div')
    outer.className = 'y'
    const element = outer.appendChild(document.createElement('div'))
    element.className = 'x'
    expect(cascaded(element, 'min-height', DESKTOP, rules)).toBe('32px')
    expect(cascaded(element, 'min-height', PHONE, rules)).toBe('44px')
    expect(cascaded(element, 'color', DESKTOP, rules)).toBe('navy')
  })

  // Matching every rule against every element made a screen's gold check take seconds, so a rule is
  // passed over when the element lacks a class its selector's last part names. Never one it could match.
  it('passes over a selector only when the element lacks a class its last part needs', () => {
    expect(neededClasses('.a > .b.c:hover')).toEqual(['b', 'c'])
    expect(neededClasses('.a~.b + .c')).toEqual(['c'])
    expect(neededClasses('.b:not(.c)')).toEqual(['b'])
    expect(neededClasses(':is(.x, .b) span')).toEqual([])
    expect(neededClasses(':where(.x) :is(.y, .z)')).toEqual([])
    expect(neededClasses('.k[data-kind=".y"]')).toEqual(['k'])
    expect(neededClasses('.md\\:flex')).toEqual([])
    const rules = rulesOf(':is(.x, .b) { color: blue } .b:not(.c) { min-height: 44px } .b.c { padding: 2px } .q .b { margin: 3px }')
    const outer = document.createElement('div')
    outer.className = 'q'
    const element = outer.appendChild(document.createElement('div'))
    element.className = 'b'
    expect(cascaded(element, 'color', DESKTOP, rules)).toBe('blue')
    expect(cascaded(element, 'min-height', DESKTOP, rules)).toBe('44px')
    expect(cascaded(element, 'padding', DESKTOP, rules)).toBeNull()
    expect(cascaded(element, 'margin', DESKTOP, rules)).toBe('3px')
    element.classList.add('c')
    expect(cascaded(element, 'padding', DESKTOP, rules)).toBe('2px')
    expect(cascaded(element, 'min-height', DESKTOP, rules)).toBeNull()
  })

  it('applies a keyboard-focus rule only to an element marked as reached by keyboard', () => {
    const rules = rulesOf(':where(button):focus-visible { outline-offset: 2px } .x:focus-visible { outline-offset: -2px }')
    const element = document.createElement('button')
    element.className = 'x'
    expect(cascaded(element, 'outline-offset', DESKTOP, rules)).toBeNull()
    element.setAttribute('data-focus-visible', '')
    expect(cascaded(element, 'outline-offset', DESKTOP, rules)).toBe('-2px')
  })
})
