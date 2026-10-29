import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    { source: 'chatgpt', total: tally(12, 40_000), lastFiveHours: tally(3, 9_000), lastSevenDays: tally(10, 30_000), activeDays: 4, peakDayTokens: 20_000, lastProblem: { kind: 'plan_limit', at: new Date().toISOString() } },
    { source: 'anthropic', total: tally(5, 100_000, 85, true), lastFiveHours: tally(0, 0), lastSevenDays: tally(5, 100_000, 85, true), activeDays: 2, peakDayTokens: 60_000 },
  ],
  days: [
    { day: today, source: 'chatgpt', ...tally(3, 9_000) },
    { day: today, source: 'anthropic', ...tally(5, 100_000, 85, true) },
  ],
  agents: [
    { team: 'Research desk', ask: false, agentId: 'writer', agentName: 'Writer', source: 'anthropic', runs: 2, ...tally(5, 100_000, 85, true) },
    { ask: true, agentId: 'ask', source: 'chatgpt', runs: 1, ...tally(12, 40_000) },
  ],
}

function respond(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  forgetKeyStatus()
  try { window.localStorage.clear() } catch { /* none */ }
  vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/usage')
    ? respond(report)
    : respond({ openrouter: { connected: false }, anthropic: { connected: true }, chatgpt: { available: true, connected: true, planUse: true } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Usage', () => {
  it('is one of You’s tabs, beside About you and Connections', async () => {
    window.history.replaceState(null, '', '/usage')
    render(<UsagePage />)
    const you = await screen.findByRole('navigation', { name: 'You' })
    expect(within(you).getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
    expect(within(you).getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections')
    expect(screen.queryByRole('link', { name: 'Back to Home' })).toBeNull()
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
    expect(within(credit).getByRole('meter', { name: /Claude API credit used by LoomWatch/ })).toHaveTextContent('≈ $85.00 of your $100')
    expect(within(credit).getByRole('link', { name: 'See exact balance' })).toHaveAttribute('href', 'https://platform.claude.com/settings/billing')

    const table = screen.getByRole('table')
    expect(within(table).getByText('Research desk')).toBeInTheDocument()
    expect(within(table).getByText('Ask LoomWatch')).toBeInTheDocument()
    expect(within(table).getByText('≈ $85.00')).toBeInTheDocument()
    expect(within(table).getByText('Plan')).toBeInTheDocument()
  })

  // What LoomWatch spends on its own, reading each message before the team works on it and learning
  // from your feedback, used to read "A team · reader". A helper read as its id, "helper~1".
  it('names LoomWatch’s own work and an agent’s helpers in plain words', async () => {
    const own: UsageReport = {
      ...report,
      agents: [
        { ask: false, agentId: 'reader', source: 'openrouter', runs: 8, ...tally(8, 14_000, 0.04) },
        { team: 'Helper · chat', ask: false, agentId: 'helper', agentName: 'Helper', source: 'openrouter', runs: 7, ...tally(7, 12_000, 0.03) },
        { ask: false, agentId: 'learner', source: 'openrouter', runs: 6, ...tally(6, 6_000, 0.02) },
        { team: 'Helper · chat', ask: false, agentId: 'helper~1', source: 'openrouter', runs: 1, ...tally(1, 2_000, 0.006) },
        // A team's own agent may have the same id: it is the team's, named as the team names it.
        { team: 'Morning digest', ask: false, agentId: 'reader', agentName: 'Reader', source: 'openrouter', runs: 1, ...tally(1, 1_000, 0.003) },
      ],
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/usage') ? respond(own) : respond({ openrouter: { connected: true } })))
    render(<UsagePage />)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').slice(0, 2).map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['LoomWatch', 'Working out what your messages need'],
      ['Helper · chat', 'Helper'],
      ['LoomWatch', 'Learning from your feedback'],
      ['Helper · chat', 'Helper’s helper 1'],
      ['Morning digest', 'Reader'],
    ])
    expect(table).not.toHaveTextContent('A team')
    expect(table).not.toHaveTextContent('~')
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
