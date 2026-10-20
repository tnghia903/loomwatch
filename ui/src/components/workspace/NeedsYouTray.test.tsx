import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useLayoutEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NeedsYouTray } from './NeedsYouTray'
import { appRules, background, cascaded, GOLD_FILLS } from '../../test/cascade'
import type { Ticket } from '../../lib/story/needsYou'

afterEach(cleanup)

const ticket: Ticket = {
  id: 'r1:permission:p1', kind: 'permission', runId: 'r1', teamPath: 'research.yaml', teamName: 'Research team', node: 'researcher', sendBackTo: null,
  asker: 'Researcher', text: 'Researcher wants to use the web', context: 'Web search · model cards 2019', since: new Date().toISOString(), requestId: 'p1',
}

describe('a permission ticket in the tray (ADR 0040)', () => {
  it('reads as a paused agent and answers Allow, Allow for this run or Deny from the buttons and keys', async () => {
    const onPermission = vi.fn(() => Promise.resolve())
    render(<NeedsYouTray tickets={[ticket]} working={0} onAnswer={vi.fn()} onPermission={onPermission} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /1 needs you/ }))
    expect(screen.getByText('Permission')).toBeInTheDocument()
    expect(screen.getByText('Researcher wants to use the web. It is paused until you answer.')).toBeInTheDocument()
    expect(screen.getByText('Web search · model cards 2019')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Answer/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Allow\s*A$/ }))
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'allow_once')
    expect(await screen.findByText('Researcher: Allowed once.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this run' }))
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'allow_run')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'd' })
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'deny')
  })
})

// ADR 0043: the run on screen asks with its own answer box and permission card, so its ticket in
// the tray says where to answer instead of offering the same buttons again; it still counts.
describe('a ticket for the run on screen', () => {
  it('points at the screen and offers none of the run’s own buttons or keys', () => {
    const onPermission = vi.fn(() => Promise.resolve())
    const other = { ...ticket, id: 'r2:permission:p2', runId: 'r2', teamName: 'Other team' }
    render(<NeedsYouTray tickets={[ticket, other]} working={0} onAnswer={vi.fn()} onPermission={onPermission} onDismiss={vi.fn()} onScreenRunId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }))
    expect(screen.getByText('On this screen: answer it below.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Allow\s*A$/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Open run/ })).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(onPermission).not.toHaveBeenCalled()
  })
})

// A bare class that turns the pointer off (the canvas's `.ghost` drop placeholder) silently kills
// any button reusing the name: the tray's Open run and Dismiss once wore it, and could not be clicked.
// Read from disk: vitest hands a `?raw` stylesheet import back empty.
const styles = resolve(process.cwd(), 'src/styles')
const sheets = readdirSync(styles).filter((name) => name.endsWith('.css')).map((name) => readFileSync(resolve(styles, name), 'utf8'))
const pointerless = new Set(sheets.flatMap((css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /pointer-events:\s*none/.test(body))
  .flatMap(([, selectors]) => selectors.split(',').map((one) => one.trim()).filter((one) => /^\.[\w-]+$/.test(one)).map((one) => one.slice(1)))))

// One gold fill per screen: the bell sits beside Run team or Save, so when something needs you it
// lights as a gold ring with a gold glyph, and its words stay ink (gold on the tint is 4.45:1 in light).
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const parsed = (css: string) => [...uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
const everyRule = sheets.flatMap(parsed)
const rules = everyRule.filter(([, selectors]) => selectors.includes('needs-you-bell'))
const declaredIn = (list: RegExpExecArray[], selector: string, property: string) => list
  .filter(([, selectors]) => selectors.split(',').some((one) => one.trim() === selector))
  .flatMap(([, , body]) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'g'))].map(([, value]) => value.trim()))
const declared = (selector: string, property: string) => declaredIn(rules, selector, property)
// The rules a phone gets: everything inside `@media (max-width: 767px)`, the app's phone layout.
const phoneRules = sheets.flatMap((css) => [...uncommented(css).matchAll(/@media \(max-width: 767px\)\s*\{/g)].flatMap((match) => {
  let at = match.index + match[0].length
  for (let depth = 1; depth > 0 && at < css.length; at += 1) depth += { '{': 1, '}': -1 }[uncommented(css)[at]] ?? 0
  return parsed(uncommented(css).slice(match.index + match[0].length, at - 1))
}))
const px = (value: string) => Number(/^(-?[\d.]+)(?:px)?$/.exec(value)?.[1] ?? NaN)

describe('the bell when something needs you', () => {
  it('lights as a gold ring with ink words, never a second gold fill', () => {
    render(<NeedsYouTray tickets={[ticket]} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    const bell = screen.getByRole('button', { name: /1 needs you/ })
    expect(bell).toHaveClass('needs-you-bell', 'has')
    expect(bell.querySelector('svg')).not.toBeNull()
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.filter(([, , body]) => /--color-accent-(?:fill|on-fill)\b/.test(body)).map(([, selectors]) => selectors.trim())).toEqual([])
    expect(declared('.needs-you-bell.has', 'background')).toEqual(['var(--color-accent-tint)'])
    expect(declared('.needs-you-bell.has', 'border-color')).toEqual(['var(--color-accent)'])
    expect(declared('.needs-you-bell.has', 'color')).toEqual(['var(--color-ink)'])
    expect(declared('.needs-you-bell.has svg', 'color')).toEqual(['var(--color-accent)'])
  })
})

describe('a stopped run’s ticket', () => {
  it('opens its run and dismisses from buttons the pointer can reach', () => {
    const onDismiss = vi.fn()
    const stopped: Ticket = { ...ticket, id: 'r9:failed', kind: 'failed', runId: 'r9', text: 'approach-research stopped.', context: null, requestId: undefined }
    render(<NeedsYouTray tickets={[stopped]} working={0} onAnswer={vi.fn()} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /1 needs you/ }))
    expect(pointerless.size).toBeGreaterThan(0)
    for (const button of screen.getByRole('dialog').querySelectorAll('button')) {
      expect([...button.classList].filter((name) => pointerless.has(name)), button.textContent ?? '').toEqual([])
    }
    expect(screen.getByRole('button', { name: /^Open run/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith('r9')
  })
})

const review = (id: string, teamName = 'Research team'): Ticket => ({ ...ticket, id: `${id}:review`, kind: 'review', runId: id, teamName, text: '', context: null, requestId: undefined })

// Two teams waiting would be two gold fills, and the design allows one per screen (CLAUDE.md, Look
// and feel): only the active ticket's main action is filled, and J and K carry the fill.
describe('the tray with several tickets open', () => {
  it('fills only the active ticket’s main action, and the fill follows the active ticket', () => {
    const first = review('fill-a', 'Team A')
    const second = { ...ticket, id: 'fill-b:permission:p1', runId: 'fill-b', teamName: 'Team B' }
    const third: Ticket = { ...ticket, id: 'fill-c:question', kind: 'question', runId: 'fill-c', teamName: 'Team C', text: 'Which city?', requestId: undefined }
    const fourth: Ticket = { ...ticket, id: 'fill-d:spend:s1', kind: 'spend', runId: 'fill-d', teamName: 'Team D', text: 'Team D reached its spending limit.', requestId: undefined, stopId: 's1', spendActions: { add: 'Add $5 and carry on', finish: 'Finish with what it has' } }
    const tray = (tickets: Ticket[]) => <NeedsYouTray tickets={tickets} working={0} onAnswer={vi.fn()} onPermission={vi.fn(() => Promise.resolve())} onSpend={vi.fn(() => Promise.resolve())} onDismiss={vi.fn()} />
    const { rerender } = render(tray([first, second, third, fourth]))
    fireEvent.click(screen.getByRole('button', { name: /4 need you/ }))
    const dialog = screen.getByRole('dialog')
    const filled = () => [...dialog.querySelectorAll('.btn-primary')].map((button) => button.textContent)
    const active = () => [...dialog.querySelectorAll('li.active .btn-primary')].map((button) => button.textContent)
    expect(filled()).toEqual(['Looks goodA'])
    for (const main of ['AllowA', 'Answer…R', 'Add $5 and carry on']) {
      fireEvent.keyDown(dialog, { key: 'j' })
      expect(filled()).toEqual([main])
      expect(active()).toEqual([main])
    }
    // The list shrinks under the last ticket: the fill and the highlight land on the new last one.
    rerender(tray([first, second]))
    expect(filled()).toEqual(['AllowA'])
    expect(active()).toEqual(['AllowA'])
    fireEvent.keyDown(dialog, { key: 'k' })
    expect(filled()).toEqual(['Looks goodA'])
    // Replying keeps one fill: Send is filled while its ticket is active, and gives it up when you move on.
    fireEvent.click(screen.getByRole('button', { name: /^Add a note/ }))
    expect(filled()).toEqual(['Send'])
    act(() => dialog.querySelector<HTMLElement>('[data-ticket="1"]')?.focus())
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveClass('btn-primary')
    expect(filled()).toEqual(['AllowA'])
  })

  it('leaves focus on a button you Tab to in another ticket, and the fill follows it there', () => {
    render(<NeedsYouTray tickets={[review('tab-a', 'Team A'), review('tab-b', 'Team B')]} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }))
    const second = screen.getAllByRole('button', { name: /^Looks good/ })[1]
    act(() => second.focus())
    expect(document.activeElement).toBe(second)
    expect(second).toHaveClass('btn-primary')
    expect(screen.getAllByRole('button', { name: /^Looks good/ })[0]).not.toHaveClass('btn-primary')
  })

  it('makes a filled button at least 32 px, and 44 px under a finger', () => {
    const heights = declaredIn(everyRule, '.ticket-acts .btn', 'height')
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(px(height)).toBeGreaterThanOrEqual(32)
    expect(phoneRules.length).toBeGreaterThan(0)
    for (const selector of ['.ticket-acts .btn', '.ticket-reply .btn', '.ticket-reply input']) expect(declaredIn(phoneRules, selector, 'height').map(px)).toEqual([44])
    // Under 16 px, iOS Safari zooms the page when the answer box takes focus.
    expect(declaredIn(phoneRules, '.ticket-reply input', 'font-size')).toEqual(['16px'])
    // Same specificity as the 32 px rule, so the phone rule only wins by coming after it.
    const sized = everyRule.filter(([, selectors, body]) => selectors.split(',').some((one) => one.trim() === '.ticket-acts .btn') && /(?:^|;)\s*height:/.test(body))
    expect(sized.map(([, , body]) => px(/height:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? '')).at(-1)).toBe(44)
  })
})

// On a phone the bell is a 30 px pill; a finger needs 44 px, so an invisible edge reaches past it.
// An absolute child is placed from inside the border, so the border counts against the reach.
describe('the bell on a phone', () => {
  it('answers a 44 px finger without looking any bigger or covering the controls beside it', () => {
    const [height] = declared('.needs-you-bell', 'height').map(px)
    const [border] = declared('.needs-you-bell', 'border').map((value) => px(value.split(' ')[0]))
    expect(height).toBe(30)
    expect(border).toBe(1)
    expect(declaredIn(phoneRules, '.needs-you-bell', 'position')).toEqual(['relative'])
    for (const property of ['height', 'min-height', 'border', 'border-width']) expect(declaredIn(phoneRules, '.needs-you-bell', property)).toEqual([])
    expect(declaredIn(phoneRules, '.needs-you-bell::before', 'content')).toEqual(["''"])
    expect(declaredIn(phoneRules, '.needs-you-bell::before', 'position')).toEqual(['absolute'])
    const reach = (selector: string) => {
      const [top, right = top, bottom = top, left = right] = (declaredIn(phoneRules, selector, 'inset')[0] ?? '').split(/\s+/).map(px)
      return { top, right, bottom, left }
    }
    // Home and the agent page: 8 px all round. The Skills link, the Ask button and the ☰ menu sit
    // 8 px from the bell's edge.
    const round = reach('.needs-you-bell::before')
    expect(height - 2 * border - round.top - round.bottom).toBeGreaterThanOrEqual(44)
    for (const side of Object.values(round)) expect(-side - border).toBeLessThan(8)
    // A team page: its view tabs sit 3 px above the bell, so it reaches down instead.
    const team = reach('.workspace-chrome .needs-you-bell::before')
    expect(team.top).toBeGreaterThanOrEqual(0)
    expect(height - 2 * border - team.top - team.bottom).toBeGreaterThanOrEqual(44)
    for (const side of [team.left, team.right]) expect(-side - border).toBeLessThan(8)
    expect(rules.filter(([selectors, , body]) => selectors.includes('::before') && /background|border|box-shadow|outline/.test(body))).toEqual([])
  })
})

// A bell that rings for as long as a ticket waits runs past WCAG 2.2.2's five seconds. It rings when
// something new arrives, then rests. jsdom has no AnimationEvent, so React listens for the prefixed name.
const glyph = () => document.querySelector('.needs-you-bell svg')
const ringEnds = () => act(() => { glyph()?.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true })) })

describe('the bell’s ring', () => {
  let now = 0
  beforeEach(() => { now += 60_000; vi.spyOn(Date, 'now').mockImplementation(() => now) })
  afterEach(() => vi.restoreAllMocks())
  const tray = (tickets: Ticket[]) => <NeedsYouTray tickets={tickets} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />

  it('rings when something new needs you, lets a ring finish, rests five seconds, and never rings for a count going down', () => {
    const [first, second, third, fourth] = ['ring-a', 'ring-b', 'ring-c', 'ring-d'].map((id) => review(id))
    const { rerender } = render(tray([]))
    expect(glyph()).not.toHaveClass('ringing')
    rerender(tray([first]))
    expect(glyph()).toHaveClass('ringing')
    // Another arriving mid-ring doesn't start it over (off and on again): the ring under way finishes.
    const classes = new MutationObserver(() => {})
    classes.observe(glyph()!, { attributeFilter: ['class'], attributeOldValue: true })
    rerender(tray([first, second]))
    expect(classes.takeRecords().filter((change) => change.oldValue !== glyph()?.getAttribute('class'))).toEqual([])
    expect(glyph()).toHaveClass('ringing')
    ringEnds()
    expect(glyph()).not.toHaveClass('ringing')
    rerender(tray([first, second]))
    expect(glyph()).not.toHaveClass('ringing')
    // Within five seconds of the last ring, something new only changes the count.
    now += 4_900
    rerender(tray([first, second, third]))
    expect(glyph()).not.toHaveClass('ringing')
    now += 100
    rerender(tray([first, second, third, fourth]))
    expect(glyph()).toHaveClass('ringing')
    ringEnds()
    now += 60_000
    rerender(tray([fourth]))
    expect(glyph()).not.toHaveClass('ringing')
  })

  it('stops when the last ticket is answered mid-ring, and still rests five seconds after', () => {
    const { rerender } = render(tray([review('ring-h')]))
    expect(glyph()).toHaveClass('ringing')
    rerender(tray([]))
    expect(glyph()).not.toHaveClass('ringing')
    now += 4_900
    rerender(tray([review('ring-i')]))
    expect(glyph()).not.toHaveClass('ringing')
    now += 100
    rerender(tray([review('ring-i'), review('ring-j')]))
    expect(glyph()).toHaveClass('ringing')
  })

  it('does not ring again for the same tickets on the next screen, which starts empty while it loads', () => {
    const waiting = review('ring-e')
    const { unmount } = render(tray([waiting]))
    expect(glyph()).toHaveClass('ringing')
    unmount()
    const { rerender } = render(tray([]))
    rerender(tray([waiting]))
    expect(glyph()).not.toHaveClass('ringing')
  })

  // Home, a team and an agent are separate pages: what the bell rang for lasts the tab's session.
  it('does not ring on the next page for tickets it rang for on the last one', () => {
    const here = review('ring-f')
    const { unmount } = render(tray([here]))
    expect(glyph()).toHaveClass('ringing')
    unmount()
    const kept = JSON.parse(sessionStorage.getItem('loomwatch.needsYou.rung') ?? '[]') as string[]
    expect(kept).toContain(here.id)
    // Rung on another page: in the session, never in this page's memory.
    const elsewhere = review('ring-g')
    sessionStorage.setItem('loomwatch.needsYou.rung', JSON.stringify([...kept, elsewhere.id]))
    render(tray([elsewhere]))
    expect(glyph()).not.toHaveClass('ringing')
  })

  it('rings twice inside five seconds, swings first, and stops for reduced motion', () => {
    expect(rules.filter(([, , body]) => /\binfinite\b/.test(body)).map(([selectors]) => selectors.trim())).toEqual([])
    expect(rules.filter(([selectors, , body]) => /(?:^|,)\s*\.needs-you-bell\.has svg\s*(?:,|$)/.test(selectors) && /\banimation/.test(body))).toEqual([])
    const [ring] = declared('.needs-you-bell.has svg.ringing', 'animation')
    const [, name, duration, times] = /^([\w-]+) (\S+) [\w-]+ (\d+)$/.exec(ring ?? '') ?? []
    const token = /^var\((--[\w-]+)\)$/.exec(duration ?? '')?.[1]
    const length = token ? new RegExp(`${token}:\\s*([^;]+);`).exec(sheets.join('\n'))?.[1]?.trim() ?? '' : duration ?? ''
    const seconds = length.endsWith('ms') ? parseFloat(length) / 1000 : parseFloat(length)
    expect(name).toBe('needs-you-ring')
    expect(seconds).toBeGreaterThan(0)
    expect(Number(times)).toBeGreaterThanOrEqual(2)
    expect(seconds * Number(times)).toBeLessThanOrEqual(5)
    const frames = /@keyframes needs-you-ring\s*\{([\s\S]*?\})\s*\}/.exec(sheets.join('\n'))?.[1] ?? ''
    const swings = [...frames.matchAll(/([\d%, ]+)\{\s*transform:\s*rotate\(([-\d.]+)(?:deg)?\)/g)]
      .filter(([, , angle]) => Number(angle) !== 0).flatMap(([at]) => at.split(',').map((one) => parseFloat(one)))
    expect(Math.min(...swings)).toBeLessThanOrEqual(10)
    // app.css: reduced motion cuts every animation to one 1 ms pass, the bell's ring with it.
    const reduced = sheets.flatMap((css) => [...uncommented(css).matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*([^{}]+)\{([^{}]*)\}/g)])
      .filter(([, selectors]) => selectors.split(',').some((one) => one.trim() === '*'))
    expect(reduced.map(([, , body]) => body).join(';')).toMatch(/animation-iteration-count:\s*1 !important/)
  })
})

// One gold fill per screen with the tray open too: its active ticket's fill is the screen's, and the
// page's own (Run team, Save, Home's Build an agent) steps back to a ring until it closes. jsdom
// paints nothing, so this runs the cascade over the app's stylesheets (test/cascade.ts).
const gold = GOLD_FILLS

describe('the open tray beside the page’s own gold fill', () => {
  afterEach(() => { delete document.documentElement.dataset.theme })
  const layout = (tray: ReactNode) => (
    <div className="lw-shell">
      <button type="button" className="btn btn-primary">Run team</button>
      <button type="button" className="btn btn-primary" disabled>Save</button>
      {tray}
    </div>
  )
  const page = (tray: ReactNode) => render(layout(tray))
  const filled = () => [...document.querySelectorAll('button')].filter((button) => gold.includes(background(button) ?? '')).map((button) => button.textContent)

  for (const theme of ['light', 'dark']) {
    it(`steps the page’s fills back to a ring while the tray shows its own, in ${theme}`, () => {
      document.documentElement.dataset.theme = theme
      page(<NeedsYouTray tickets={[review('page-a'), review('page-b')]} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
      expect(appRules.length).toBeGreaterThan(everyRule.length / 2)
      const run = screen.getByRole('button', { name: 'Run team' })
      expect(filled()).toEqual(['Run team'])
      fireEvent.click(screen.getByRole('button', { name: /2 need you/ }))
      expect(filled()).toEqual(['Looks goodA'])
      expect(background(run)).toBe('transparent')
      expect(cascaded(run, 'color')).toBe('var(--color-ink)')
      expect(cascaded(run, 'border-color')).toBe('var(--color-accent)')
      // A button that can't be pressed keeps its grey: a gold ring would read as one that can.
      expect(background(screen.getByRole('button', { name: 'Save' }))).toBe('var(--color-hairline)')
      // Hovered, the ring takes the tint every other button does; the tray's fill stays gold.
      run.setAttribute('data-hovered', '')
      expect(background(run)).toBe('var(--color-accent-tint)')
      expect(cascaded(run, 'filter')).toBe('none')
      const [main] = screen.getAllByRole('button', { name: /^Looks good/ })
      main.setAttribute('data-hovered', '')
      expect(gold).toContain(background(main))
      run.removeAttribute('data-hovered')
      // J moves the fill to the next ticket; the page stays a ring.
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'j' })
      expect(filled()).toEqual(['Looks goodA'])
      expect(screen.getAllByRole('button', { name: /^Looks good/ })[1]).toHaveClass('btn-primary')
      // A press outside closes the tray first, so the page gets its fill back before the click lands.
      fireEvent.mouseDown(run)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(filled()).toEqual(['Run team'])
    })
  }

  it('leaves the page its fill while the tray has none: nothing waiting, a stopped run, a ticket answered on this screen', () => {
    const stopped: Ticket = { ...ticket, id: 'page-s:failed', kind: 'failed', runId: 'page-s', text: 'It stopped.', context: null, requestId: undefined }
    const tray = (tickets: Ticket[], onScreenRunId: string | null = null) => <NeedsYouTray tickets={tickets} working={0} onAnswer={vi.fn()} onPermission={vi.fn(() => Promise.resolve())} onDismiss={vi.fn()} onScreenRunId={onScreenRunId} />
    const { rerender } = page(tray([]))
    fireEvent.click(screen.getByRole('button', { name: /All clear/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(filled()).toEqual(['Run team'])
    rerender(layout(tray([stopped])))
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(filled()).toEqual(['Run team'])
    // The ticket on screen says "answer it below", and below is the page's own fill.
    rerender(layout(tray([ticket], ticket.runId)))
    expect(screen.getByText('On this screen: answer it below.')).toBeInTheDocument()
    expect(filled()).toEqual(['Run team'])
    // A ticket with an answer here takes the fill, and the page's steps back.
    rerender(layout(tray([ticket])))
    expect(filled()).toEqual(['AllowA'])
  })

  // ⌘N opens Create a team over the tray, and Tab walks out of it onto the page: focus leaving the
  // tray closes it, so the dialog's or the page's own main button is filled again before it's pressed.
  it('gives the page its fill back when focus leaves the tray, and keeps it open while focus moves inside', () => {
    page(<NeedsYouTray tickets={[review('page-f'), review('page-g')]} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    const bell = screen.getByRole('button', { name: /2 need you/ })
    fireEvent.click(bell)
    act(() => screen.getAllByRole('button', { name: /^Add a note/ })[1].focus())
    act(() => bell.focus())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(filled()).toEqual(['Looks goodA'])
    act(() => screen.getByRole('button', { name: 'Run team' }).focus())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(filled()).toEqual(['Run team'])
  })

  // A poll, not a click, can bring the first ticket into the open tray, and React paints before a
  // plain effect runs: the mark has to be there by the time anything after the tray lays out.
  it('marks the page before it paints when a ticket arrives in the open tray', () => {
    const seen: boolean[] = []
    function LaidOut() { useLayoutEffect(() => { seen.push('needsYouFill' in document.documentElement.dataset) }); return null }
    const tray = (tickets: Ticket[]) => <><NeedsYouTray tickets={tickets} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} /><LaidOut /></>
    const { rerender } = render(tray([]))
    fireEvent.click(screen.getByRole('button', { name: /All clear/ }))
    expect(seen.at(-1)).toBe(false)
    rerender(tray([review('page-p')]))
    expect(seen.at(-1)).toBe(true)
  })

  it('gives the page its fill back when the tray goes away open', () => {
    const { unmount } = render(<NeedsYouTray tickets={[review('page-u')]} working={0} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /1 needs you/ }))
    const outside = document.createElement('button')
    outside.className = 'btn btn-primary'
    document.body.append(outside)
    expect(gold).not.toContain(background(outside))
    unmount()
    expect(gold).toContain(background(outside))
    outside.remove()
  })
})
