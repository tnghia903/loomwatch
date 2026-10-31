import { cleanup, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { ByHand } from './ByHand'
import { openBenchRows } from '../../test/benchRows'

// Each setting is a row that opens; these tests are about the editors inside them.
openBenchRows()

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [] }

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const bench = (start: Partial<AgentDraft>, hideDoes = false) => render(
  <ByHand draft={{ ...BLANK_DRAFT, ...start }} set={() => {}} skills={[]} skillsLoading={false} hideDoes={hideDoes} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />,
)

describe('By hand: the Name block', () => {
  it('says the name once, in its box, labelled as for one of My agents', () => {
    bench({ name: 'RAG researcher' }, true)
    const block = screen.getByRole('region', { name: 'Name' })
    expect(within(block).getByRole('textbox', { name: 'Name' })).toHaveValue('RAG researcher')
    expect(within(block).queryByText(/RAG researcher/)).not.toBeInTheDocument()
    // A team's own agent has no "What it does", but its Name box reads the same as one of My agents'.
    expect(within(block).queryByRole('textbox', { name: /What it does/ })).not.toBeInTheDocument()
    expect(within(block).queryByText('Name', { selector: '.visually-hidden' })).not.toBeInTheDocument()
  })

  it('says what it does once too, in its own box', () => {
    bench({ name: 'RAG researcher', does: 'Finds papers' })
    const block = screen.getByRole('region', { name: 'Name' })
    expect(within(block).getByRole('textbox', { name: /What it does/ })).toHaveValue('Finds papers')
    expect(within(block).queryByText(/RAG researcher|Finds papers/)).not.toBeInTheDocument()
    // Beside a second box, "Name" says which box is which.
    expect(within(block).queryByText('Name', { selector: '.visually-hidden' })).not.toBeInTheDocument()
  })
})
