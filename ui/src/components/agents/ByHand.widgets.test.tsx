import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, specFromDraft } from '../../lib/library/draft'
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

const draw = (draft = BLANK_DRAFT, widgetsDefault?: boolean) => {
  const set = vi.fn()
  render(<ByHand draft={draft} set={set} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'chubby', color: 'sage' }} record={null} widgetsDefault={widgetsDefault} />)
  return { set, toggle: screen.getByRole('button', { name: /Adds charts, checklists and calculators to its answers/ }) }
}

// ADR 0114: each agent's own switch, under what it hands back; absent, LoomWatch's default.
describe('By hand: widgets under its answers', () => {
  it('shows LoomWatch’s default for an agent with no setting, and writes the other when pressed', () => {
    const off = draw(BLANK_DRAFT, false)
    expect(off.toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(off.toggle)
    expect(off.set).toHaveBeenCalledWith('widgets', true)
    cleanup()
    const on = draw(BLANK_DRAFT, true)
    expect(on.toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(on.toggle)
    expect(on.set).toHaveBeenCalledWith('widgets', false)
  })

  it('shows the agent’s own setting over the default, and saves it with the agent', () => {
    const { toggle } = draw({ ...BLANK_DRAFT, widgets: true }, false)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(specFromDraft({ ...BLANK_DRAFT, name: 'Planner', widgets: true }).widgets).toBe(true)
    expect(specFromDraft({ ...BLANK_DRAFT, name: 'Planner' })).not.toHaveProperty('widgets')
  })
})
