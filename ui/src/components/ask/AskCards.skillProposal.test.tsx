import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillProposalCard } from '../../lib/ask/thread'
import { SKILLS_CHANGED_EVENT } from '../../lib/library/client'
import type { SkillRecord, SkillWords } from '../../lib/library/skillStore'
import { AskCardView, type CardActions } from './AskCards'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Sent = { method: string; url: string; body?: Record<string, unknown> }

/** The daemon, answering by method and path; every request is kept. */
function daemon(answer: (sent: Sent) => Response | undefined) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined }
    sent.push(request)
    return answer(request) ?? json({ error: `no route for ${request.method} ${request.url}` }, 404)
  }))
  return sent
}

const record = (name: string): SkillRecord => ({
  name, description: `Does ${name} things.`, origin: { kind: 'written' }, license: { restricted: false },
  needs: [], runtimes: [], hasScripts: false, sizeBytes: 100, sha256: 'f'.repeat(64), addedAt: '2026-11-08T00:00:00Z',
})

const WORDS: SkillWords = {
  name: 'weekly-update', description: 'Writes the weekly update.', instructions: '1. Read the notes.\n2. Write five bullets.\n3. Sign it Mai.', files: [], base: 'base-1',
}

const change: SkillProposalCard = {
  kind: 'skill-proposal', id: 's1', at: '2026-11-08T09:00:00Z', skill: 'weekly-update', title: null, isNew: false,
  summary: 'Three bullets, not five.', description: WORDS.description, instructions: '1. Read the notes.\n2. Write three bullets.\n3. Sign it Mai.',
  base: 'base-1', givenTo: ['Writer'], outcome: null, superseded: false,
}

const fresh: SkillProposalCard = {
  ...change, id: 's2', skill: 'weekly-client-update', title: 'Weekly client update', isNew: true, base: null, givenTo: [],
  summary: 'A skill for your weekly client update.', description: 'Writes the weekly update for a client.', instructions: '1. Read the notes.\n2. Write three bullets.',
}

function actions(overrides: Partial<CardActions> = {}): CardActions {
  return {
    previewingId: null, savedYamlFor: () => null, busyCard: null, cardError: null,
    onShowProposal: vi.fn(), onApply: vi.fn(), onDiscard: vi.fn(), onStartRun: vi.fn(), onDeclineRun: vi.fn(), onOpenRun: vi.fn(), onUseNote: vi.fn(),
    onOpenAgent: vi.fn(), onDiscardAgent: vi.fn(), onSkillSettled: vi.fn(),
    ...overrides,
  }
}

describe('a skill Ask proposed, on its card (ADR 0121)', () => {
  it('opens a new skill on the Skills page’s sheet, filled in, and saves it only there', async () => {
    const sent = daemon((request) => {
      if (request.method === 'PUT' && request.url === '/api/skills/words') return json({ skill: record('weekly-client-update'), base: 'base-new' })
      return undefined
    })
    const onSkillSettled = vi.fn()
    render(<AskCardView card={fresh} actions={actions({ onSkillSettled })} />)
    const card = screen.getByRole('article', { name: 'Proposed skill Weekly client update' })
    expect(within(card).getByText('New skill')).toBeTruthy()
    expect(within(card).getByText('When to use it: “Writes the weekly update for a client.”')).toBeTruthy()
    expect(within(card).getByText('Nothing is saved until you press Save skill.')).toBeTruthy()
    expect(sent).toEqual([])

    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByLabelText('Name')).toHaveValue('Weekly client update')
    expect(within(sheet).getByLabelText('When to use it')).toHaveValue(fresh.description)
    expect(within(sheet).getByLabelText('What to do')).toHaveValue(fresh.instructions)
    expect(onSkillSettled).not.toHaveBeenCalled()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save skill' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent.find((request) => request.method === 'PUT')?.body).toEqual({
      name: 'weekly-client-update', description: fresh.description, instructions: fresh.instructions,
    })
    expect(onSkillSettled).toHaveBeenCalledWith(fresh, 'applied')
    expect(within(card).getByText('Saved')).toBeTruthy()
    // Open is gone, so focus lands on the card that says Saved, not on the page.
    await waitFor(() => expect(document.activeElement).toBe(card))
    expect(within(card).queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('says what a change changes against the skill as it is now, and saves it from the words Ask read', async () => {
    const sent = daemon((request) => {
      if (request.url === '/api/skills/words?name=weekly-update') return json(WORDS)
      if (request.method === 'GET' && request.url === '/api/skills') return json({ folder: '/skills', skills: [record('weekly-update')] })
      if (request.method === 'PUT') return json({ skill: record('weekly-update'), base: 'base-2', previous: WORDS })
      return undefined
    })
    const onSkillSettled = vi.fn()
    render(<AskCardView card={change} actions={actions({ onSkillSettled })} />)
    const card = screen.getByRole('article', { name: 'Proposed change to Weekly update' })
    expect(await within(card).findByText('What to do: 1 line changed')).toBeTruthy()
    expect(within(card).getByText('Saving changes it for every agent that uses it, including Writer')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    const sheet = screen.getByRole('dialog')
    await waitFor(() => expect(within(sheet).getByLabelText('What to do')).toHaveValue(change.instructions))
    const marked = within(sheet).getByRole('region', { name: 'What LoomWatch changed' })
    expect([...marked.querySelectorAll('ins')].map((part) => part.textContent).join('')).toContain('three')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save skill' }))
    await waitFor(() => expect(onSkillSettled).toHaveBeenCalledWith(change, 'applied'))
    expect(sent.find((request) => request.method === 'PUT')?.body).toMatchObject({ name: 'weekly-update', base: 'base-1', instructions: change.instructions })
    await waitFor(() => expect(within(card).getByText('Saved')).toBeTruthy())
  })

  it('offers only Discard for a change made from words the skill no longer has, or a skill that is gone', async () => {
    daemon((request) => (request.url === '/api/skills/words?name=weekly-update' ? json({ ...WORDS, base: 'base-2' }) : undefined))
    const onSkillSettled = vi.fn()
    const { unmount } = render(<AskCardView card={change} actions={actions({ onSkillSettled })} />)
    expect(await screen.findByText('Weekly update was changed after Ask read it. Ask again for a new change.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    expect(screen.queryByText(/What to do:/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onSkillSettled).toHaveBeenCalledWith(change, 'discarded')
    unmount()

    daemon(() => json({ error: 'There’s no skill named “weekly-update” in LoomWatch.' }, 404))
    render(<AskCardView card={change} actions={actions()} />)
    expect(await screen.findByText('Weekly update isn’t in your skills any more.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('keeps a sheet the person has open when a later draft replaces its card', () => {
    daemon(() => undefined)
    const { rerender } = render(<AskCardView card={fresh} actions={actions()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    rerender(<AskCardView card={{ ...fresh, superseded: true }} actions={actions()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('An earlier draft of “Weekly client update”, replaced by the one below.')).toBeTruthy()
  })

  it('is stale once the skill is saved elsewhere, but a skill it can’t read now isn’t gone', async () => {
    let base = 'base-1'
    let answer: 'words' | 'broken' = 'broken'
    daemon((request) => {
      if (request.url !== '/api/skills/words?name=weekly-update') return undefined
      return answer === 'broken' ? json({ error: 'The daemon stopped.' }, 500) : json({ ...WORDS, base })
    })
    render(<AskCardView card={change} actions={actions()} />)
    // A read that fails isn't a skill that's gone: Open stays, for the sheet to say what's wrong.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.queryByText(/isn’t in your skills/)).toBeNull()
    // A save anywhere in the app reads the skill again.
    answer = 'words'
    act(() => { window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT)) })
    expect(await screen.findByText('What to do: 1 line changed')).toBeTruthy()
    base = 'base-2'
    act(() => { window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT)) })
    expect(await screen.findByText('Weekly update was changed after Ask read it. Ask again for a new change.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('names the words Ask read to the sheet, which says so when the skill changed since the card looked', async () => {
    let base = 'base-1'
    daemon((request) => {
      if (request.url === '/api/skills/words?name=weekly-update') return json({ ...WORDS, base })
      if (request.method === 'GET' && request.url === '/api/skills') return json({ folder: '/skills', skills: [record('weekly-update')] })
      return undefined
    })
    render(<AskCardView card={change} actions={actions()} />)
    expect(await screen.findByText('What to do: 1 line changed')).toBeTruthy()
    // Changed by hand, with no word to the app: the card can't know, the sheet reads it again.
    base = 'base-2'
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const sheet = screen.getByRole('dialog')
    expect(await within(sheet).findByText('This skill was changed after Ask read it, so Ask’s change isn’t shown. Ask again for a new change.')).toBeTruthy()
    expect(within(sheet).queryByRole('region', { name: 'What LoomWatch changed' })).toBeNull()
    expect(within(sheet).getByLabelText('What to do')).toHaveValue(WORDS.instructions)
  })

  it('discards an open card, and says when that couldn’t be recorded', () => {
    daemon(() => undefined)
    const onSkillSettled = vi.fn()
    const { rerender } = render(<AskCardView card={fresh} actions={actions({ onSkillSettled })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onSkillSettled).toHaveBeenCalledWith(fresh, 'discarded')
    rerender(<AskCardView card={fresh} actions={actions({ onSkillSettled, cardError: { id: fresh.id, message: 'The daemon isn’t answering.' } })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The daemon isn’t answering.')
  })

  it('says how it ended, or that a later draft replaced it', () => {
    daemon(() => undefined)
    const { unmount } = render(<AskCardView card={{ ...change, outcome: 'discarded' }} actions={actions()} />)
    expect(screen.getByText('Discarded')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    unmount()
    render(<AskCardView card={{ ...change, superseded: true }} actions={actions()} />)
    expect(screen.getByText('An earlier draft of “Weekly update”, replaced by the one below.')).toBeTruthy()
  })
})
