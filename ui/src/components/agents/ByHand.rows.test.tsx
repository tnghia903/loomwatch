import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import type { FigurePart } from '../../lib/library/figure'
import { ByHand } from './ByHand'

// The bench is WebGL; here it is one part to pick: the laptop, which opens the Model row.
vi.mock('./AgentFigure', () => ({ default: ({ onPart }: { onPart: (part: FigurePart) => void }) => <button type="button" onClick={() => onPart('app')}>The laptop</button> }))

beforeEach(() => {
  forgetModels()
  // jsdom has no scrolling: picking a part on the bench scrolls its row into view.
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Bench({ start }: { start: Partial<AgentDraft> }) {
  const [draft, setDraft] = useState<AgentDraft>({ ...BLANK_DRAFT, ...start })
  return <ByHand draft={draft} set={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />
}
const row = (title: RegExp) => screen.getByRole('button', { name: title })

// Round 3 (ADR 0101): each setting is a row that says what it is set to, and opens to change it.
it('shows each setting as a row with what it is set to, and opens one to change it', () => {
  render(<Bench start={{ name: 'Writer', does: 'Drafts posts', instructions: 'Write a short draft.' }} />)
  expect(row(/^Name Writer · Drafts posts/)).toHaveAttribute('aria-expanded', 'false')
  expect(row(/^Model /)).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('textbox', { name: 'Instructions' })).toBeNull()
  fireEvent.click(row(/^Instructions /))
  expect(row(/^Instructions /)).toHaveAttribute('aria-expanded', 'true')
  const instructions = screen.getByRole('textbox', { name: 'Instructions' })
  fireEvent.change(instructions, { target: { value: 'Write a short draft with a title.' } })
  // Closed, it is hidden, not gone: what was written is there when it opens again.
  fireEvent.click(row(/^Instructions /))
  expect(screen.queryByRole('textbox', { name: 'Instructions' })).toBeNull()
  fireEvent.click(row(/^Instructions /))
  expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Write a short draft with a title.')
  // The region keeps its plain name, for the reader that goes by regions.
  expect(screen.getByRole('region', { name: 'Model' })).toBeInTheDocument()
})

it('opens a blank agent on its name and instructions, where it starts', () => {
  render(<Bench start={{}} />)
  expect(row(/^Name\b/)).toHaveAttribute('aria-expanded', 'true')
  expect(row(/^Instructions /)).toHaveAttribute('aria-expanded', 'true')
  expect(row(/^Model /)).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
  // Open, the name is in its box only, not said again in its row.
  expect(within(screen.getByRole('region', { name: 'Name' })).queryByText(/No name yet/)).toBeNull()
})

it('opens the row for the part picked on the bench, and puts the focus in it', async () => {
  render(<Bench start={{ name: 'Writer', instructions: 'Write.' }} />)
  expect(row(/^Model /)).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByRole('button', { name: 'The laptop' }))
  expect(row(/^Model Thinks with /)).toHaveAttribute('aria-expanded', 'true')
  // Its first field takes the focus, not the row it opened from.
  await waitFor(() => expect(document.activeElement?.closest('.byhand-row-body')).not.toBeNull())
})
