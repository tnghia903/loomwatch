import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import type { UsageReport } from '../../lib/usage/client'
import { usageNotices } from '../../lib/usage/notices'
import { UsagePage } from './UsagePage'

const tally = (calls: number, tokens: number, cost = 0, estimated = false) => ({ calls, inputTokens: tokens, cachedTokens: 0, outputTokens: 0, costUsd: cost, costEstimated: estimated })
const today = new Date().toISOString().slice(0, 10)

const report: UsageReport = {
  since: '2026-09-19T00:00:00Z',
  sources: [
    { source: 'chatgpt', total: tally(12, 40_000), loomwatch: tally(4, 6_000), lastFiveHours: tally(3, 9_000), lastSevenDays: tally(10, 30_000), activeDays: 4, peakDayTokens: 20_000, lastProblem: { kind: 'plan_limit', at: new Date().toISOString() } },
    { source: 'anthropic', total: tally(5, 100_000, 85, true), loomwatch: tally(1, 2_000, 5, true), lastFiveHours: tally(0, 0), lastSevenDays: tally(5, 100_000, 85, true), activeDays: 2, peakDayTokens: 60_000 },
  ],
  days: [
    { day: today, source: 'chatgpt', ...tally(3, 9_000), loomwatch: tally(1, 2_000) },
    { day: today, source: 'anthropic', ...tally(5, 100_000, 85, true), loomwatch: tally(1, 2_000, 5, true) },
  ],
  agents: [
    { team: 'Research desk', agentId: 'writer', agentName: 'Writer', source: 'anthropic', runs: 2, ...tally(4, 98_000, 80, true) },
    { team: 'Cole · chat', agentId: 'cole', agentName: 'Cole', source: 'chatgpt', runs: 3, ...tally(8, 34_000) },
  ],
  features: [
    { feature: 'ask', source: 'anthropic', ...tally(1, 2_000, 5, true) },
    { feature: 'next_steps', source: 'chatgpt', ...tally(3, 4_000) },
    { feature: 'reading', source: 'chatgpt', ...tally(1, 2_000) },
  ],
}

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

/** What was asked of LoomWatch beyond reading: each change a switch made. */
let changed: { url: string; body: unknown }[] = []
let nextSteps = { on: true, written: 3, spent: 0 }
let reading = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
/** Whether an OpenRouter key is connected, which Let AI choose reads through. */
let openrouter = false

beforeEach(() => {
  forgetKeyStatus()
  changed = []
  nextSteps = { on: true, written: 3, spent: 0 }
  reading = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
  openrouter = false
  // The notch is the Mac's, so its row depends on the computer: a Mac unless a test says not.
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  try { window.localStorage.clear() } catch { /* none */ }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, boolean>
      changed.push({ url, body })
      if (url === '/api/next-steps') nextSteps = { ...nextSteps, on: body.on }
      if (url === '/api/models/reading') reading = { ...reading, enabled: body.enabled }
    }
    if (url.startsWith('/api/usage')) return respond(report)
    if (url === '/api/next-steps') return respond(nextSteps)
    if (url === '/api/models/reading') return respond(reading)
    return respond({ openrouter: { connected: openrouter }, anthropic: { connected: true }, chatgpt: { available: true, connected: true, planUse: true } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Usage', () => {
  it('is one of You’s tabs, beside About you and Connections', async () => {
    window.history.replaceState(null, '', '/usage')
    render(<UsagePage />)
    const you = await screen.findByRole('navigation', { name: 'You' })
    expect(within(you).getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
    expect(within(you).getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections')
    expect(screen.queryByRole('link', { name: 'Back to Home' })).toBeNull()
    // What the page counts is under its title's "?", one press away.
    expect(screen.queryByText(/by how it was paid/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Usage' }))
    expect(screen.getByRole('note')).toHaveTextContent('What your agents and LoomWatch’s help used in the last 30 days, by how it was paid')
  })

  it('says what each way of paying counts, what it can’t, and where to see the rest', async () => {
    render(<UsagePage />)
    const plan = await screen.findByRole('region', { name: 'Your ChatGPT plan' })
    expect(within(plan).getByText('3 requests')).toBeInTheDocument()
    expect(within(plan).getByText(/LoomWatch hit a limit on .*ChatGPT doesn’t say when it resets/)).toBeInTheDocument()
    expect(within(plan).getByRole('link', { name: 'Manage usage' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
    // Its chart counts tokens, never dollars.
    expect(within(plan).getByRole('img', { name: /Tokens a day/ })).toBeInTheDocument()

    const credit = screen.getByRole('region', { name: 'Your Claude API credit' })
    expect(within(credit).getByText(/Anthropic doesn’t tell apps how much credit is left/)).toBeInTheDocument()
    fireEvent.change(within(credit).getByLabelText('Your plan'), { target: { value: '100' } })
    expect(within(credit).getByRole('meter', { name: /Claude API credit used in LoomWatch/ })).toHaveTextContent('≈ $85.00 of your $100')
    expect(within(credit).getByRole('link', { name: 'See exact balance' })).toHaveAttribute('href', 'https://platform.claude.com/settings/billing')
  })

  it('shows at a glance what the agents’ work used and what LoomWatch’s own help used, as shares, dollars and plan tokens apart', async () => {
    render(<UsagePage />)
    const tracks = await screen.findByRole('region', { name: 'What models were used for' })
    expect(tracks).toHaveTextContent(/^Last 30 days/)
    const [agents, help] = within(tracks).getAllByRole('heading', { level: 2 }).map((heading) => heading.parentElement!)
    expect(agents).toHaveTextContent('Your agents')
    expect(agents).toHaveTextContent('≈ $80.00 94% of the cost')
    expect(agents).toHaveTextContent('34k tokens 85% of the tokens')
    expect(help).toHaveTextContent('LoomWatch’s help')
    expect(help).toHaveTextContent('≈ $5.00 6% of the cost')
    expect(help).toHaveTextContent('6k tokens 15% of the tokens')
    expect(help).toHaveTextContent('suggestions at the notch')

    // Each way of paying says the same split for the same days, in its chart's unit, right over it.
    const split = (name: string) => screen.getByRole('region', { name }).querySelector('.usage-split')
    expect(split('Your ChatGPT plan')).toHaveTextContent('30 days:Your agents 34k tokensLoomWatch’s help 6k tokens')
    expect(split('Your Claude API credit')).toHaveTextContent('30 days:Your agents ≈ $80.00LoomWatch’s help ≈ $5.00')
    expect(split('Your Claude API credit')!.nextElementSibling).toHaveClass('usage-bars')
    const plan = within(screen.getByRole('region', { name: 'Your ChatGPT plan' })).getByRole('img', { name: /Tokens a day/ })
    expect(within(plan).getByLabelText(/LoomWatch’s help/)).toHaveAccessibleName(/3 requests, 9k tokens, LoomWatch’s help 2k tokens/)

    // The bars draw LoomWatch's share at each day's foot, striped and set apart by a gap, never by
    // tone alone; the day's readout says it in words.
    const credit = screen.getByRole('region', { name: 'Your Claude API credit' })
    const bars = within(credit).getByRole('img', { name: /Dollars a day.*LoomWatch’s help is striped/ })
    const help_ = bars.querySelector<SVGPathElement>('.usage-bar-part')!
    const stripes = /url\(#(.+)\)/.exec(help_.getAttribute('fill') ?? '')?.[1]
    expect(stripes && bars.querySelector(`pattern[id="${stripes}"]`)).toBeTruthy()
    const whole = help_.parentElement!.querySelector('.usage-bar')!
    const foot = Number(/^M[\d.]+,([\d.]+)/.exec(whole.getAttribute('d')!)![1])
    const top = Number(/ V([\d.]+)/.exec(help_.getAttribute('d')!)![1])
    expect(foot).toBeLessThan(top)
    expect(within(bars).getByLabelText(/LoomWatch’s help/)).toHaveAccessibleName(/≈ \$85\.00, 5 requests, LoomWatch’s help ≈ \$5\.00/)
  })

  it('lists the agents’ work by team and agent, and LoomWatch’s own help by what it did', async () => {
    render(<UsagePage />)
    const where = await screen.findByRole('region', { name: 'Where it went' })
    const [work, help] = within(where).getAllByRole('table')
    const cells = (table: HTMLElement, count: number) => within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').slice(0, count).map((cell) => cell.textContent))
    expect(cells(work, 2)).toEqual([['Research desk', 'Writer'], ['Own chat', 'Cole']])
    expect(work).not.toHaveTextContent('Ask')
    expect(cells(help, 3)).toEqual([
      ['Ask LoomWatch', 'Claude credit', '1'],
      ['Next-step suggestions at the notch', 'ChatGPT plan', '3'],
      ['Working out what a message needs', 'ChatGPT plan', '1'],
    ])
    expect(within(help).getAllByText('Plan')).toHaveLength(2)
    // Why most of it has no switch is under its heading's "?".
    fireEvent.click(within(where).getByRole('button', { name: 'About LoomWatch’s help' }))
    expect(within(where).getByRole('note')).toHaveTextContent('Ask runs only when you use it')
  })

  // A switch for help that can't run here is one to keep up for nothing.
  it('lists a switch before its help is used only where it can do something: the notch on a Mac, choosing models with OpenRouter', async () => {
    const unused: UsageReport = { ...report, features: [{ feature: 'ask', source: 'anthropic', ...tally(1, 2_000, 5, true) }] }
    const help = async () => {
      const where = await screen.findByRole('region', { name: 'Where it went' })
      const table = within(where).getAllByRole('table')[1]
      return within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell, column) => column === 0 ? cell.querySelector('.usage-feature-name')!.textContent : cell.textContent))
    }
    const show = () => vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/usage') ? respond(unused) : url === '/api/next-steps' ? respond(nextSteps) : url === '/api/models/reading' ? respond(reading) : respond({ openrouter: { connected: openrouter }, anthropic: { connected: true } })))

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    show()
    render(<UsagePage />)
    expect((await help()).map(([what]) => what)).toEqual(['Ask LoomWatch'])
    expect(screen.getByRole('region', { name: 'What models were used for' })).not.toHaveTextContent('notch')
    cleanup()

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    openrouter = true
    forgetKeyStatus()
    show()
    render(<UsagePage />)
    await screen.findByRole('switch', { name: 'Let AI choose agents’ models' })
    // Not used yet: nothing to count, and no number that looks like one.
    expect(await help()).toEqual([
      ['Ask LoomWatch', 'Claude credit', '1', expect.any(String), '≈ $5.00'],
      ['Next-step suggestions at the notch', '–', '–', '–', '–'],
      ['Choosing agents’ models', '–', '–', '–', '–'],
    ])
    // Each switch sits beside its feature's name, so a narrow screen never scrolls to reach it.
    for (const name of ['Write next-step suggestions at the notch', 'Let AI choose agents’ models']) {
      expect(screen.getByRole('switch', { name }).closest('td')!.querySelector('.usage-feature-name')).not.toBeNull()
    }
  })

  // What LoomWatch spends on its own used to sit among the agents. A helper read as its id, "helper~1".
  it('names an agent’s helpers in plain words, and an answer in its own chat as its own chat', async () => {
    const own: UsageReport = {
      ...report,
      agents: [
        { team: 'Helper · chat', agentId: 'helper', agentName: 'Helper', source: 'openrouter', runs: 7, ...tally(7, 12_000, 0.03) },
        { team: 'Helper · chat', agentId: 'helper~1', source: 'openrouter', runs: 1, ...tally(1, 2_000, 0.006) },
        // A team's own agent may share an id with LoomWatch's reader: it is the team's.
        { team: 'Morning digest', agentId: 'reader', agentName: 'Reader', source: 'openrouter', runs: 1, ...tally(1, 1_000, 0.003) },
        { agentId: 'cole', agentName: 'Cole', source: 'openrouter', runs: 1, ...tally(1, 500, 0.001) },
      ],
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/usage') ? respond(own) : url === '/api/next-steps' ? respond(nextSteps) : url === '/api/models/reading' ? respond(reading) : respond({ openrouter: { connected: true } })))
    render(<UsagePage />)
    const where = await screen.findByRole('region', { name: 'Where it went' })
    const [work] = within(where).getAllByRole('table')
    const rows = within(work).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').slice(0, 2).map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['Own chat', 'Helper'],
      ['Own chat', 'Helper’s helper 1'],
      ['Morning digest', 'Reader'],
      ['Own chat', 'Cole'],
    ])
    expect(work).not.toHaveTextContent('· chat')
    expect(work).not.toHaveTextContent('A team')
    expect(work).not.toHaveTextContent('~')
  })

  it('turns the help a person can do without off and on from its row: next steps, and choosing models', async () => {
    openrouter = true
    render(<UsagePage />)
    const writing = await screen.findByRole('switch', { name: 'Write next-step suggestions at the notch' })
    const choosing = await screen.findByRole('switch', { name: 'Let AI choose agents’ models' })
    expect(writing).toBeChecked()
    expect(choosing).not.toBeChecked()
    // What turning it on spends is said before it is turned on.
    expect(choosing).toHaveAccessibleDescription('Uses your OpenRouter credits.')
    // One switch a feature, however many ways it was paid.
    expect(screen.getAllByRole('switch')).toHaveLength(2)

    fireEvent.click(writing)
    await waitFor(() => expect(writing).not.toBeChecked())
    fireEvent.click(choosing)
    await waitFor(() => expect(choosing).toBeChecked())
    expect(screen.queryByText(/Uses your OpenRouter credits/)).toBeNull()
    expect(changed).toEqual([
      { url: '/api/next-steps', body: { on: false } },
      { url: '/api/models/reading', body: { enabled: true } },
    ])
  })

  it('gives a heads-up for a limit hit today and credit nearly spent, and nothing otherwise', () => {
    const now = new Date()
    window.localStorage.setItem('loomwatch.usage.claudePlan', JSON.stringify({ monthly: 100, renewsOn: 1 }))
    const said = usageNotices(report, now, 0.5).map((notice) => notice.label)
    expect(said).toEqual(['Manage usage', 'See exact balance', 'See usage'])
    window.localStorage.clear()
    expect(usageNotices({ ...report, sources: [] }, now, null)).toEqual([])
  })
})
