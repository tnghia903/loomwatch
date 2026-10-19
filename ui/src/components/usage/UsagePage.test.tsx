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

  it('gives a heads-up for a limit hit today and credit nearly spent, and nothing otherwise', () => {
    const now = new Date()
    window.localStorage.setItem('loomwatch.usage.claudePlan', JSON.stringify({ monthly: 100, renewsOn: 1 }))
    const said = usageNotices(report, now, 0.5).map((notice) => notice.label)
    expect(said).toEqual(['Manage usage', 'See exact balance', 'See usage'])
    window.localStorage.clear()
    expect(usageNotices({ ...report, sources: [] }, now, null)).toEqual([])
  })
})
