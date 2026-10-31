import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { ByHand } from './ByHand'
import { openBenchRows } from '../../test/benchRows'

// Each setting is a row that opens; these tests are about the editors inside them.
openBenchRows()

// Once bringing in ships (ADR 0092): the agent's own switch is on its workbench.
vi.mock('../../lib/library/bringIn', async (original) => ({ ...(await original<object>()), BRINGING_IN_SHIPPED: true }))
vi.mock('./AgentFigure', () => ({ default: () => null }))

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fetchedAt: '2026-10-25T00:00:00Z', defaultModel: 'acme/plain-1', recommended: [], models: [] }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderByHand(draft: Partial<AgentDraft>) {
  const set = vi.fn()
  render(<ByHand draft={{ ...BLANK_DRAFT, ...draft }} set={set} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />)
  return set
}

describe('By hand: bringing in one of My agents', () => {
  it('is on unless turned off, and turning it off writes it on the agent', () => {
    const set = renderByHand({})
    const on = screen.getByRole('button', { name: /Can bring in other agents from My agents/ })
    expect(on).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(on)
    expect(set).toHaveBeenCalledWith('bringsIn', false)
  })

  it('turns back on by forgetting the off', () => {
    const set = renderByHand({ bringsIn: false })
    const off = screen.getByRole('button', { name: /Can bring in other agents from My agents/ })
    expect(off).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(off)
    expect(set).toHaveBeenCalledWith('bringsIn', undefined)
  })
})
