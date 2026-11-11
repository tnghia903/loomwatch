import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  // ADR 0100: Home's delete and rename dialogs open inside the studio too; each fades in as any
  // dialog does, never rising in with the page.
  it('leave a delete’s or a rename’s dialog on Home out of the page’s arrival', () => {
    const at = page('<div class="studio"><section id="desk"></section><div id="scrim" class="lw-scrim dim"><div class="pop e2 lw-deleteteam"></div></div></div>')
    expect(animation(at('#scrim'))).toMatch(/^fade-in /)
    expect(animation(at('.lw-deleteteam'))).toMatch(/^dialog-in /)
    // Opened after the page's parts, it is a later child: no arrival delay holds it back.
    // Wherever it lands among them: second to sixth and after.
    for (const before of [1, 2, 3, 4, 5]) {
      const late = page(`<div class="studio">${'<section></section>'.repeat(before)}<div id="scrim" class="lw-scrim dim"></div></div>`)
      expect(cascaded(late('#scrim'), 'animation-delay'), `after ${before}`).toBeNull()
    }
    const parts = page('<div class="studio"><section></section><section></section><section></section><section></section><section id="fifth"></section></div>')
    expect(cascaded(parts('#fifth'), 'animation-delay')).toBe('160ms')
  })

  it('keep a lifted team card’s open menu above the cards after it', () => {
    const at = page('<div class="team-card"><button aria-expanded="true"></button></div>')
    expect(cascaded(at('.team-card'), 'z-index')).toBe('3')
  })

  // ADR 0100: a project card on Home lifts under the pointer, which stays on its open "…".
  it('keep a lifted project card’s open "…" above the cards after it', () => {
    const at = page('<article class="room-card"><span class="room-card-menu"><button aria-expanded="true"></button></span></article><article id="closed" class="room-card"></article>')
    expect(cascaded(at('.room-card'), 'z-index')).toBe('3')
    expect(cascaded(at('#closed'), 'z-index')).toBeNull()
  })

  it('breathe a working figure’s glow, and hold the others still', () => {
    const at = page('<span id="w" class="desk-figure" data-glow="working"></span><span id="r" class="desk-figure" data-glow="ready"></span><span id="q" class="desk-figure" data-glow="waiting"></span>')
    expect(animation(at('#w'))).toMatch(/^mark-breathe .* infinite$/)
    expect(animation(at('#r'))).toBeNull()
    expect(animation(at('#q'))).toBeNull()
  })

  // WebKit draws an animated filter again on every frame the screen shows: eased smoothly, the
  // glow kept a Mac at 5–14% of a core on Home for as long as a team worked.
  it('breathe a working glow on the eased curve, drawn about 8 times a second, not every frame', () => {
    const at = page('<span id="w" class="desk-figure" data-glow="working"></span><a id="m" class="fr-mark lw-mark" data-breathe></a>')
    for (const id of ['#w', '#m']) expect(animation(at(id))).toBe('mark-breathe var(--t-breathe) steps(1, jump-end) infinite')
    const css = readFileSync(resolve(process.cwd(), 'src/styles', 'motion.css'), 'utf8')
    const block = /@keyframes mark-breathe \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    const stops = [...block.matchAll(/(\d+)% \{ filter: drop-shadow\(0 0 1px var\(--glow\)\) drop-shadow\(0 0 ([\d.]+)px var\(--glow\)\); \}/g)].map((stop) => ({ at: Number(stop[1]), glow: Number(stop[2]) }))
    // A stop every 5% of the 2.4 s breath (120 ms), each with the 1px rim, from the still 3px out to 6px and back.
    expect(stops.map((stop) => stop.at)).toEqual(Array.from({ length: 20 }, (_, index) => index * 5))
    expect(stops[0].glow).toBe(3)
    expect(stops[10].glow).toBe(6)
    for (let index = 1; index < stops.length; index += 1) {
      const change = stops[index].glow - stops[index - 1].glow
      expect(Math.abs(change)).toBeLessThanOrEqual(0.5)
      expect(Math.sign(change)).toBe(index <= 10 ? 1 : -1)
    }
    // Eased: slow at the ends, quick in the middle.
    expect(stops[1].glow - stops[0].glow).toBeLessThan(stops[6].glow - stops[5].glow)
  })

  // The same cost in the team chat, on the faces of whoever works. Its glow breathes from each face's
  // own still look (pointed at, or without the baton), so it keeps its one keyframe and steps its ease.
  it('breathe a working face’s glow in the chat on the eased curve, in six flat steps each way', () => {
    const at = page('<div class="tc-replies-faces"><span class="chat-avatar working"><img id="c" class="chat-avatar-figure"></span></div><div class="tc-member working"><img id="h" class="chat-avatar-figure"></div>')
    for (const id of ['#c', '#h']) {
      // What a browser without `linear()` keeps: the ease it always had.
      expect(cascaded(at(id), 'animation')).toBe('tc-glow var(--t-flow) ease-in-out infinite')
      const timing = cascaded(at(id), 'animation-timing-function') ?? ''
      expect(timing).toMatch(/^linear\(/)
      const points = [...timing.matchAll(/([\d.]+) ([\d.]+)%/g)].map(([, value, place]) => ({ value: Number(value), place: Number(place) }))
      // Pairs: each step holds its value flat from where it starts to where the next one starts.
      const steps: { value: number; from: number; to: number }[] = []
      for (let index = 0; index + 1 < points.length; index += 2) steps.push({ value: points[index].value, from: points[index].place, to: points[index + 1].place })
      expect(steps.length).toBe(6)
      expect(points.at(-1)).toEqual({ value: 1, place: 100 })
      const levels = [...steps.map((step) => step.value), 1]
      for (const [index, step] of steps.entries()) {
        expect(points[index * 2 + 1].value).toBe(step.value)
        expect(step.to - step.from).toBeLessThanOrEqual(16.67)
        if (index > 0) expect(step.value).toBeGreaterThan(steps[index - 1].value)
        // Eased in and out alike: a step this far from the start is as far below the top.
        expect(step.value + levels[levels.length - 1 - index]).toBeCloseTo(1, 3)
      }
      // Slow at the ends, quick in the middle.
      expect(levels[1] - levels[0]).toBeLessThan(levels[3] - levels[2])
    }
  })

  // A loop no one is looking at is only work (figuresStill.ts): the glows hold still with the figures.
  it('hold the working glows still while the window is in the background', () => {
    const at = page('<span id="w" class="desk-figure" data-glow="working"></span><div class="tc-replies-faces"><span class="chat-avatar working"><img id="c" class="chat-avatar-figure"></span></div><div class="tc-member working"><img id="h" class="chat-avatar-figure"></div>')
    const playing = (id: string) => cascaded(at(id), ['animation', 'animation-play-state'])
    for (const id of ['#w', '#c', '#h']) expect(playing(id)).not.toBe('paused')
    document.documentElement.classList.add('figures-still')
    try {
      for (const id of ['#w', '#c', '#h']) expect(playing(id)).toBe('paused')
    } finally {
      document.documentElement.classList.remove('figures-still')
    }
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
