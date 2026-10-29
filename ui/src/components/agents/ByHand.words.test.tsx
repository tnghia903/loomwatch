import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { ByHand } from './ByHand'
import { benchLabels } from './benchOf'

// The bench's 3D figure is beside the point here: its labels are tested through benchLabels.
vi.mock('./AgentFigure', () => ({ default: () => null }))

// The picture's own names. A newcomer setting up an agent reads settings, not a scene to decode, and
// "key" is already what pays for models (an OpenRouter key, a Claude API key).
const PICTURE_WORDS = /recipe card|pegboard|key hook|\bkeys?\b|your dish|\bdish\b|\btray\b|nameplate|clipboard|drawer|laptop|hand it over|take it back/i

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const catalog = { fetchedAt: '2026-10-29T00:00:00Z', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [] }

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/skills' ? json({ folder: '/skills', skills: [] }) : json(catalog))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Bench({ start }: { start: Partial<AgentDraft> }) {
  const [draft, setDraft] = useState<AgentDraft>({ ...BLANK_DRAFT, ...start })
  return <ByHand draft={draft} set={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'spool', color: 'butter' }} record={null} />
}

/** Every word on the page a person can read or hear: its text, and its labels and titles. */
function everyWord(): string {
  const labels = [...document.body.querySelectorAll('[aria-label], [title], [placeholder]')]
    .flatMap((element) => ['aria-label', 'title', 'placeholder'].map((name) => element.getAttribute(name) ?? ''))
  return [document.body.textContent ?? '', ...labels].join('\n')
}

describe('an agent’s settings, in plain words', () => {
  it('names each setting, never the thing the bench draws it as', () => {
    render(<Bench start={{ name: 'Reader', instructions: 'Read the forms. Reply with a short list.', skills: ['pdf'], allow: { web: true } }} />)
    expect(everyWord()).not.toMatch(PICTURE_WORDS)
  })

  it('sums it up in one sentence of what it does without asking, and what it asks you first', () => {
    render(<Bench start={{ name: 'Reader', skills: ['pdf'], allow: { web: true } }} />)
    expect(document.querySelector('.byhand-say')).toHaveTextContent('Reader thinks with')
    expect(document.querySelector('.byhand-say')).toHaveTextContent('has 1 skill, and reads nothing yet. It searches the web without asking, and asks you before it edits files or runs commands.')
  })

  it('says it asks before all three when nothing is allowed, and that it asks about nothing when everything is', () => {
    const { unmount } = render(<Bench start={{ name: 'Reader' }} />)
    expect(document.querySelector('.byhand-say')).toHaveTextContent('has no skills yet, and reads nothing yet. It asks you before it searches the web, edits files or runs commands.')
    unmount()
    render(<Bench start={{ name: 'Reader', allow: { web: true, edits: true, commands: true } }} />)
    expect(document.querySelector('.byhand-say')).toHaveTextContent('It searches the web, edits files and runs commands without asking you.')
  })

  it('offers each switch as Allow or Ask me first, and the sentence follows the press', () => {
    render(<Bench start={{ name: 'Reader', allow: { web: true } }} />)
    const block = screen.getByRole('region', { name: 'What it may do without asking' })
    // Each row says its setting before its button, so the button reads as what pressing it does.
    const rows = within(block).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('em')?.textContent?.split('.')[0])).toEqual(['Allowed', 'Asks you first', 'Asks you first'])
    expect(block.querySelector('.byhand-block-says')).toHaveTextContent('Searches the web without asking; asks you before it edits files or runs commands')
    fireEvent.click(within(block).getByRole('button', { name: 'Allow: edit files' }))
    expect(document.querySelector('.byhand-say')).toHaveTextContent('It searches the web and edits files without asking, and asks you before it runs commands.')
    fireEvent.click(within(block).getByRole('button', { name: 'Ask me first: search the web' }))
    expect(document.querySelector('.byhand-say')).toHaveTextContent('It edits files without asking, and asks you before it searches the web or runs commands.')
  })
})

describe('the bench’s labels', () => {
  const draft: AgentDraft = { ...BLANK_DRAFT, name: 'Reader', instructions: 'Read the forms.', skills: ['pdf'], allow: { web: true } }
  const labels = (asked: 'web' | 'edits' | 'commands' | null = null) => benchLabels({ draft, model: 'Claude Opus 5.5', effort: 'medium', reads: [], readsSaid: 'Nothing yet', toolsSaid: 'Files, the web and commands, as you allow', asked })
  const words = (list: ReturnType<typeof labels>) => list.flatMap((label) => [typeof label.text === 'string' ? label.text : '', typeof label.short === 'string' ? label.short : '', label.label]).join('\n')

  it('say what each part is, in words, never the object it is drawn as', () => {
    expect(words(labels())).not.toMatch(PICTURE_WORDS)
    expect(words(labels('commands'))).not.toMatch(PICTURE_WORDS)
  })

  it('split what it may do into what it is allowed and what it asks you first', () => {
    const byAnchor = Object.fromEntries(labels().map((label) => [label.anchor, label]))
    expect(byAnchor.keys.text).toBe('Allowed · Web')
    expect(byAnchor.dish.text).toBe('Asks you first · Edit files, Commands')
    expect(byAnchor.reply.text).toBe('Hands back · not said yet')
  })

  it('say what a run is asking to do', () => {
    const dish = labels('commands').find((label) => label.anchor === 'dish')!
    expect(dish.text).toBe('It’s asking to run commands')
    expect(dish.short).toBe('Asking: Commands')
  })
})
