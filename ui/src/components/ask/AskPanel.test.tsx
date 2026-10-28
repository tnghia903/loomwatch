import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MODEL } from '../../lib/ai/modelIds'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetModels } from '../../lib/ai/useModels'
import { EMPTY_THREAD, type AskThread, type ProposalCard, type ReviewNoteCard, type RunRequestCard, type RunStartedCard } from '../../lib/ask/thread'
import type { AskController } from '../../lib/ask/useAsk'
import type { CardActions } from './AskCards'
import { AskButton } from './AskButton'
import { AskPanel } from './AskPanel'

const model = (id: string, name: string) => ({ id, name, contextLength: 200_000, inputPrice: 2, outputPrice: 10, free: false, reasoning: true })
const opus = model(DEFAULT_MODEL, 'Anthropic: Claude Opus 5.5')
const haiku = model('anthropic/claude-haiku-5.5', 'Anthropic: Claude Haiku 5.5')
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: opus.id, recommended: [opus, haiku], models: [opus, haiku] }

beforeEach(() => {
  forgetModels()
  forgetKeyStatus()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const body = String(input) === '/api/ai' ? { openrouter: { connected: true } } : catalog
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function controller(overrides: Partial<AskController> = {}): AskController {
  return {
    open: true, setOpen: vi.fn(), selectedModel: DEFAULT_MODEL, chooseModel: vi.fn(), needsKey: false,
    conversationId: null, unavailable: null, thread: EMPTY_THREAD, activity: null, pending: null, ended: false, sending: false, sentAt: null,
    error: null, dismissError: vi.fn(), askBeforeRun: true, setAskBeforeRun: vi.fn(), draft: '', setDraft: vi.fn(), focusRequest: 0,
    ask: vi.fn(), send: vi.fn(async () => true), startOver: vi.fn(),
    ...overrides,
  }
}

function cards(overrides: Partial<CardActions> = {}): CardActions {
  return {
    previewingId: null, savedYamlFor: () => null, busyCard: null, cardError: null,
    onShowProposal: vi.fn(), onApply: vi.fn(), onDiscard: vi.fn(), onStartRun: vi.fn(), onDeclineRun: vi.fn(), onOpenRun: vi.fn(), onUseNote: vi.fn(),
    ...overrides,
  }
}

const TEAM = 'schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents:\n  - { id: a, name: Collector, role: Collect, model: m, spawn: { cmd: c, args: [], env: {}, cwd: "." } }\n  - { id: b, name: Writer, role: Write, model: m, spawn: { cmd: c, args: [], env: {}, cwd: "." } }\nedges:\n  - { from: a, to: b, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z" }\n'
const proposal: ProposalCard = { kind: 'proposal', id: 'p1', at: '2026-10-02T09:00:00Z', file: 'brief.yaml', name: 'Brief', isNew: true, summary: 'Gathers and writes.', yaml: TEAM, agentNames: {}, outcome: null, superseded: false }
const request: RunRequestCard = { kind: 'run-request', id: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today’s news', steps: 2, decision: null, runId: null }
const note: ReviewNoteCard = { kind: 'review-note', id: 'n1', runId: 'run-1', file: 'brief.yaml', name: 'You', question: 'Approve the brief?', text: 'Approved. Keep it short.' }

function threadWith(...cardsInTurn: (ProposalCard | RunRequestCard | ReviewNoteCard | RunStartedCard)[]): AskThread {
  return {
    state: 'ready', error: null, appName: 'LoomWatch', appId: 'loomwatch', model: DEFAULT_MODEL,
    items: [
      { kind: 'person', id: 'm1', text: 'Make me a brief team' },
      { kind: 'assistant', id: 'a1', steps: [{ id: 's1', label: 'Checked the models', status: 'done', detail: null }], text: 'Here it is.', cards: cardsInTurn, done: true, thinking: false },
    ],
  }
}

describe('AskPanel', () => {
  it('shows what you typed and the request it drafted as Markdown, keeping your lines', async () => {
    const thread = threadWith({ ...request, request: 'Today’s **AI** news\nfrom `feeds.txt`' })
    thread.items[0] = { kind: 'person', id: 'm1', text: 'Make me a team that:\nhas two agents\n- gathers **news**\n- writes it up' }
    render(<AskPanel ask={controller({ thread })} view="home" cards={cards()} />)
    const yours = (await screen.findByText('news', { selector: 'strong' })).closest('.ask-you-said') as HTMLElement
    expect(yours.querySelectorAll('li')).toHaveLength(2)
    expect(yours.querySelectorAll('br')).toHaveLength(1)
    const drafted = screen.getByText('AI', { selector: 'strong' }).closest('blockquote') as HTMLElement
    expect(drafted.querySelector('code')).toHaveTextContent('feeds.txt')
    expect(drafted.querySelector('br')).not.toBeNull()
  })

  it('shows the request of a run it started with its Markdown', async () => {
    const started: RunStartedCard = { kind: 'run-started', id: 's1', runId: 'run-9', file: 'brief.yaml', request: 'Today’s **AI** news from `feeds.txt`' }
    render(<AskPanel ask={controller({ thread: threadWith(started) })} view="home" cards={cards()} />)
    const quote = (await screen.findByText('AI', { selector: 'strong' })).closest('blockquote') as HTMLElement
    expect(quote.querySelector('code')).toHaveTextContent('feeds.txt')
  })

  it('opens with what Ask can do and suggestions for where the person is, which send at a click', () => {
    const ask = controller()
    render(<AskPanel ask={ask} view="home" cards={cards()} />)
    expect(screen.getByRole('heading', { name: 'Ask LoomWatch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Model: Claude Opus 5.5. Change' }).closest('.ask-app-line')).toHaveTextContent('Using Claude Opus 5.5')
    expect(screen.getByText(/Nothing is saved or run until you say so/)).toBeInTheDocument()
    const suggestions = within(screen.getByRole('list', { name: 'Try asking' })).getAllByRole('button')
    expect(suggestions).toHaveLength(3)
    fireEvent.click(suggestions[0])
    expect(ask.send).toHaveBeenCalledWith(suggestions[0].textContent)
  })

  it('sends on Enter, keeps a new line on Shift+Enter, and gives the words back if sending failed', async () => {
    const send = vi.fn(async () => false)
    const ask = controller({ draft: 'Add a fact-checker', send })
    render(<AskPanel ask={ask} view="build" cards={cards()} />)
    const box = screen.getByRole('textbox', { name: 'Message to Ask LoomWatch' })
    expect(box).toHaveAttribute('placeholder', 'Ask for a change, or say “run it”')
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('Add a fact-checker')
    expect(ask.setDraft).toHaveBeenCalledWith('')
    await vi.waitFor(() => expect(ask.setDraft).toHaveBeenLastCalledWith('Add a fact-checker'))
  })

  it('shows the ways to pay in place of the conversation until one is connected, and keeps the box closed', async () => {
    render(<AskPanel ask={controller({ needsKey: true, unavailable: 'Ask needs a way to pay for its model.' })} view="home" cards={cards()} />)
    expect(screen.getByText(/Ask needs a way to pay for its model/)).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Choose how Ask’s model is paid' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'OpenRouter (pay per use)' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to Ask LoomWatch' })).toBeDisabled()
    expect(screen.queryByRole('list', { name: 'Try asking' })).toBeNull()
  })

  it('shows what the assistant is doing while it works, and Esc closes the panel', () => {
    const ask = controller({ thread: threadWith(), activity: 'Drafting the team' })
    render(<AskPanel ask={ask} view="home" cards={cards()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Drafting the team…')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('log', { name: 'Conversation' }), { key: 'Escape' })
    expect(ask.setOpen).toHaveBeenCalledWith(false)
  })

  it('offers a proposal for the canvas, and Apply or Discard once it is there', () => {
    const actions = cards()
    const { rerender } = render(<AskPanel ask={controller({ thread: threadWith(proposal) })} view="home" cards={actions} />)
    const card = screen.getByRole('article', { name: 'Proposed team: Brief' })
    expect(within(card).getByText('2 steps: Collector → Writer')).toBeInTheDocument()
    // The getting-started guide follows Ask: the panel, a proposal still to show, then its Apply.
    expect(card.closest('[data-tour="ask"]')).not.toBeNull()
    expect(card).toHaveAttribute('data-tour', 'ask-proposal')
    fireEvent.click(within(card).getByRole('button', { name: /Show on canvas/ }))
    expect(actions.onShowProposal).toHaveBeenCalledWith('p1', proposal)

    rerender(<AskPanel ask={controller({ thread: threadWith(proposal) })} view="build" cards={{ ...actions, previewingId: 'p1' }} />)
    const shown = screen.getByRole('article', { name: 'Proposed team: Brief' })
    expect(shown).not.toHaveAttribute('data-tour')
    expect(within(shown).getByRole('button', { name: 'Apply' })).toHaveAttribute('data-tour', 'apply-proposal')
    fireEvent.click(within(shown).getByRole('button', { name: 'Apply' }))
    expect(actions.onApply).toHaveBeenCalled()

    rerender(<AskPanel ask={controller({ thread: threadWith({ ...proposal, outcome: 'applied' }) })} view="build" cards={actions} />)
    expect(within(screen.getByRole('article', { name: 'Proposed team: Brief' })).getByText('Applied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show on canvas/ })).not.toBeInTheDocument()
  })

  it('waits for Start run before a run the assistant asked for, and says when it started', () => {
    const actions = cards()
    const { rerender } = render(<AskPanel ask={controller({ thread: threadWith(request) })} view="build" cards={actions} />)
    const card = screen.getByRole('article', { name: 'Run Brief?' })
    expect(within(card).getByText('2 steps')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Start run' }))
    expect(actions.onStartRun).toHaveBeenCalledWith(request)
    fireEvent.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(actions.onDeclineRun).toHaveBeenCalledWith(request)

    rerender(<AskPanel ask={controller({ thread: threadWith({ ...request, decision: 'started', runId: 'run-7' }) })} view="build" cards={actions} />)
    fireEvent.click(screen.getByRole('button', { name: /Watch the run/ }))
    expect(actions.onOpenRun).toHaveBeenCalledWith('run-7', 'brief.yaml')
  })

  it('puts a drafted review note in the review box rather than sending it', () => {
    const actions = cards()
    render(<AskPanel ask={controller({ thread: threadWith(note) })} view="run" cards={actions} />)
    const card = screen.getByRole('article', { name: 'Drafted review note' })
    expect(within(card).getByText('Approved. Keep it short.')).toBeInTheDocument()
    expect(within(card).getByText('You read it and send it yourself.')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Put it in the review box' }))
    expect(actions.onUseNote).toHaveBeenCalledWith(note)
  })

})

describe('Choosing the model', () => {
  it('lists the recommended models and chooses one', async () => {
    const ask = controller()
    render(<AskPanel ask={ask} view="home" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model: Claude Opus 5.5. Change' }))
    const list = await screen.findByRole('listbox', { name: 'Models by how they are paid' })
    fireEvent.click(within(list).getByRole('option', { name: /Claude Haiku 5\.5/ }))
    expect(ask.chooseModel).toHaveBeenCalledWith(haiku.id)
    expect(screen.queryByRole('dialog', { name: 'Choose the model Ask runs on' })).not.toBeInTheDocument()
    // No conversation yet, so nothing warns about starting a new one.
    expect(screen.queryByText(/starts a new conversation/)).not.toBeInTheDocument()
  })

  it('keeps the conversation when the same model is chosen, and says a change starts a new one', async () => {
    const ask = controller({ thread: threadWith() })
    render(<AskPanel ask={ask} view="build" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model: Claude Opus 5.5. Change' }))
    expect(screen.getByText('Changing the model starts a new conversation.')).toBeInTheDocument()
    fireEvent.click(within(await screen.findByRole('listbox', { name: 'Models by how they are paid' })).getByRole('option', { name: /Claude Opus 5\.5/ }))
    expect(ask.chooseModel).not.toHaveBeenCalled()
  })

  it('shows the model a live conversation started with, even when another is chosen for the next one', () => {
    render(<AskPanel ask={controller({ selectedModel: haiku.id, thread: { ...threadWith(), model: 'openai/gpt-6.1-sol' } })} view="build" cards={cards()} />)
    expect(screen.getByRole('button', { name: 'Model: GPT-6.1 Sol. Change' })).toBeInTheDocument()
  })

  it('cannot be changed while a message is on its way', () => {
    render(<AskPanel ask={controller({ sending: true })} view="build" cards={cards()} />)
    expect(screen.getByRole('button', { name: 'Model: Claude Opus 5.5. Change' })).toBeDisabled()
  })
})

describe('AskButton', () => {
  it('says when the assistant is working, and whether the panel is open', () => {
    const { rerender } = render(<AskButton ask={controller({ open: false, activity: 'Drafting the team' })} />)
    expect(screen.getByRole('button', { name: 'Ask LoomWatch (Drafting the team)' })).toHaveAttribute('aria-pressed', 'false')
    rerender(<AskButton ask={controller({ open: true })} />)
    expect(screen.getByRole('button', { name: 'Ask LoomWatch' })).toHaveAttribute('aria-pressed', 'true')
  })
})
