import { afterEach, describe, expect, it } from 'vitest'

import { cascaded, DESKTOP, type Viewport } from '../test/cascade'

const STILL: Viewport = { ...DESKTOP, reducedMotion: true }
const animation = (element: Element, viewport: Viewport = DESKTOP) => cascaded(element, ['animation', 'animation-name'], viewport)

afterEach(() => { document.body.innerHTML = '' })

function page(html: string) {
  document.body.innerHTML = html
  return (selector: string) => document.querySelector(selector)!
}

// The owner, 2026-10-30: "add in animation where possible. Current app looks rough."
describe('round 3’s screens move', () => {
  it('bring a place’s parts in one after another, and hold nothing once they are in', () => {
    const at = page('<main class="home-main agents-main"><h1 id="a"></h1><section id="b"></section><section id="c"></section></main><ul class="home-grid agents-grid"><li id="d"></li><li></li><li></li><li></li><li></li><li></li><li></li><li id="e"></li></ul>')
    expect(animation(at('#a'))).toMatch(/^rise-in .* backwards$/)
    expect(cascaded(at('#b'), 'animation-delay')).toBe('40ms')
    expect(cascaded(at('#c'), 'animation-delay')).toBe('80ms')
    expect(animation(at('#d'))).toMatch(/^rise-in .* backwards$/)
    // A long page never waits.
    expect(cascaded(at('#e'), 'animation-delay')).toBe('200ms')
    // A `translate` left filling keeps a containing block under fixed menus: arrivals never fill forwards.
    for (const id of ['#a', '#d']) expect(animation(at(id))).not.toMatch(/\b(both|forwards)\b/)
  })

  it('draw the dock’s stitch in, pop its count only when it rises, and fade a name in', () => {
    const at = page('<nav class="lw-dock"><a class="lw-dock-place"><span class="lw-dock-icon"><span id="same" class="lw-dock-count">2</span><span id="rose" class="lw-dock-count rose">3</span></span><span class="lw-dock-label">Home</span><svg class="lw-dock-stitch"></svg></a></nav>')
    expect(animation(at('.lw-dock-stitch'))).toMatch(/^stitch-in /)
    expect(animation(at('#rose'))).toMatch(/^count-pop var\(--t-move\) var\(--ease-out\)/)
    expect(animation(at('#same'))).toBeNull()
    expect(animation(at('.lw-dock-label'))).toMatch(/^fade-in /)
  })

  it('pop the stepped-up figure only when it is new, and after the page has arrived', () => {
    const at = page('<ul class="glance-needs"><li id="new" class="glance-up" data-new><span class="desk-figure"></span></li><li id="seen" class="glance-up"><span class="desk-figure"></span></li></ul>')
    expect(animation(at('#new .desk-figure'))).toMatch(/^figure-pop var\(--t-spring\) var\(--ease-spring\) var\(--t-entrance\)/)
    expect(animation(at('#seen .desk-figure'))).toBeNull()
  })

  it('leave New project’s dialog out of the page’s arrival', () => {
    const at = page('<div class="studio"><section id="desk"></section><div id="dialog" class="set-up-backdrop"></div></div>')
    expect(animation(at('#desk'))).toMatch(/^rise-in /)
    expect(animation(at('#dialog')) ?? '').not.toMatch(/rise-in/)
  })

  it('keep a lifted team card’s open menu above the cards after it', () => {
    const at = page('<div class="team-card"><button aria-expanded="true"></button></div>')
    expect(cascaded(at('.team-card'), 'z-index')).toBe('3')
  })

  it('breathe a working figure’s glow, and hold the others still', () => {
    const at = page('<span id="w" class="desk-figure" data-glow="working"></span><span id="r" class="desk-figure" data-glow="ready"></span><span id="q" class="desk-figure" data-glow="waiting"></span>')
    expect(animation(at('#w'))).toMatch(/^mark-breathe .* infinite$/)
    expect(animation(at('#r'))).toBeNull()
    expect(animation(at('#q'))).toBeNull()
  })

  it('hold a working glow still while Ask’s glass floats over the page', () => {
    const at = page('<div class="lw-app"><span id="w" class="desk-figure" data-glow="working"></span><aside class="ask-panel on-home"></aside></div>')
    expect(animation(at('#w'))).toBe('none')
  })

  it('open what opens toward you: the workbench, a row, a question, connecting a device', () => {
    const at = page('<div class="team-agents-page"></div><div class="byhand-row-body"></div><div class="byhand-row-body" hidden></div><div class="e2 lw-confirm leave"></div><div class="lw-devices-connect"></div>')
    expect(animation(at('.team-agents-page'))).toMatch(/^sheet-in /)
    expect(animation(document.querySelectorAll('.byhand-row-body')[0])).toMatch(/^pop-in /)
    expect(animation(document.querySelectorAll('.byhand-row-body')[1])).toBeNull()
    expect(animation(at('.lw-confirm'))).toMatch(/^pop-in-up /)
    expect(animation(at('.lw-devices-connect'))).toMatch(/^pop-in /)
  })

  it('lift the agent you point at on My agents', () => {
    const at = page('<button class="home-card agent-card" data-hovered><div class="agent-tile"><span class="desk-figure agent-tile-figure"></span></div></button>')
    expect(cascaded(at('.agent-tile-figure'), 'translate')).toBe('0 -3px')
  })

  it('give under a press, but never inside the canvas', () => {
    const at = page('<button id="out" class="btn"></button><div class="react-flow"><button id="in" class="btn"></button></div>')
    // jsdom has no :active; the press rule is asked about directly.
    expect(cascaded(at('#out'), 'transition')).toMatch(/scale var\(--t-instant\)/)
    expect(cascaded(at('#in'), 'transition')).not.toMatch(/scale/)
  })

  it('keep everything still when motion is reduced', () => {
    const at = page('<main class="agents-main"><h1 id="a"></h1></main><span id="w" class="desk-figure" data-glow="working"></span><div class="team-agents-page"></div><svg class="lw-dock-stitch"></svg><span class="lw-dock-count rose"></span>')
    for (const selector of ['#a', '#w', '.team-agents-page', '.lw-dock-stitch', '.lw-dock-count']) expect(animation(at(selector), STILL)).toBeNull()
  })
})
