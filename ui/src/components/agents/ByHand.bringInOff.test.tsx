import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BRINGING_IN_SHIPPED, MY_AGENTS_LISTED_BY_DEFAULT } from '../../lib/library/bringIn'
import { BLANK_DRAFT } from '../../lib/library/draft'
import { ByHand } from './ByHand'
import { openBenchRows } from '../../test/benchRows'

// Each setting is a row that opens; these tests are about the editors inside them.
openBenchRows()

vi.mock('./AgentFigure', () => ({ default: () => null }))

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fetchedAt: '2026-10-25T00:00:00Z', defaultModel: 'acme/plain-1', recommended: [], models: [] }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// ADR 0092 ships off until the bench shows it helps: a switch that changes nothing isn't shown.
describe('By hand, while bringing in my agents is off everywhere', () => {
  it('shows no switch for it', () => {
    expect(MY_AGENTS_LISTED_BY_DEFAULT).toBe(0)
    expect(BRINGING_IN_SHIPPED).toBe(false)
    render(<ByHand draft={BLANK_DRAFT} set={vi.fn()} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />)
    expect(screen.getByRole('button', { name: /Brings in helpers for big tasks/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Can bring in other agents/ })).toBeNull()
  })
})
