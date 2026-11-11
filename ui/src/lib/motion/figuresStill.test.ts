import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchFiguresStill } from './figuresStill'

// The test setup blanks CSS imports, so the file is read as it is on disk.
const motion = readFileSync(resolve(process.cwd(), 'src/styles/motion.css'), 'utf8')

afterEach(() => vi.restoreAllMocks())

describe('the figures’ idle breath (step 5, the review’s motion rules)', () => {
  it('holds still while the window is in the background, and moves again when it is back', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stop = watchFiguresStill()
    const still = () => document.documentElement.classList.contains('figures-still')
    expect(still()).toBe(false)
    focused.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    expect(still()).toBe(true)
    focused.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    expect(still()).toBe(false)
    stop()
    focused.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    expect(still()).toBe(false)
  })

  it('never loops under reduced motion or a glass panel, and only ready and working breathe', () => {
    const loops = [...motion.matchAll(/^[^\n]*infinite[^\n]*$/gm)].map((line) => line[0]).filter((line) => line.includes('figure-breathe'))
    expect(loops.length).toBeGreaterThan(0)
    for (const loop of loops) expect(loop).toMatch(/\[data-glow="ready"\], \[data-glow="working"\]/)
    // Every figure motion is inside the reduced-motion guard.
    const guarded = motion.slice(motion.indexOf('/* ---- Figures: a new state'))
    const block = guarded.slice(guarded.indexOf('@media (prefers-reduced-motion: no-preference) {'), guarded.indexOf('@keyframes pose-settle'))
    expect(block).toContain('figure-breathe')
    expect(block).toContain('[data-moved][data-pose="waiting"]')
    expect(block).toMatch(/html\.figures-still \.desk-figure > \*,\s*html:has\(\.ask-glass, \.inspector-glass, \.lw-modal-scrim\) \.desk-figure > \* \{ animation-play-state: paused; \}/)
    // The settles play once: none of them is infinite.
    for (const line of block.split('\n').filter((l) => l.includes('[data-moved]'))) expect(line.replace(/figure-breathe[^,;]*/g, '')).not.toContain('infinite')
  })
})
