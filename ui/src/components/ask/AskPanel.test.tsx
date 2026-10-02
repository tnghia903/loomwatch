import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_THREAD, type AskThread, type ProposalCard, type ReviewNoteCard, type RunRequestCard } from '../../lib/ask/thread'
import type { AskController } from '../../lib/ask/useAsk'
import type { CardActions } from './AskCards'
import { AskButton } from './AskButton'
import { AskPanel } from './AskPanel'

afterEach(cleanup)

function controller(overrides: Partial<AskController> = {}): AskController {
  return {
    open: true, setOpen: vi.fn(), apps: { apps: [{ id: 'claude', name: 'Claude', available: true, reason: null }], defaultApp: 'claude' },
    conversationId: null, unavailable: null, thread: EMPTY_THREAD, activity: null, pending: null, ended: false, sending: false, sentAt: null,
    error: null, dismissError: vi.fn(), askBeforeRun: true, setAskBeforeRun: vi.fn(), draft: '', setDraft: vi.fn(), focusRequest: 0,
    ask: vi.fn(), send: vi.fn(async () => true), startOver: vi.fn(), inbox: [], inboxUnseen: 0, markInboxSeen: vi.fn(),
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
const proposal: ProposalCard = { kind: 'proposal', id: 'p1', at: '2026-10-02T09:00:00Z', file: 'brief.yaml', name: 'Brief', isNew: true, summary: 'Gathers and writes.', yaml: TEAM, outcome: null, superseded: false }
const request: RunRequestCard = { kind: 'run-request', id: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today’s news', apps: ['Claude'], steps: 2, decision: null, runId: null }
const note: ReviewNoteCard = { kind: 'review-note', id: 'n1', runId: 'run-1', file: 'brief.yaml', name: 'You', question: 'Approve the brief?', text: 'Approved. Keep it short.' }

function threadWith(...cardsInTurn: (ProposalCard | RunRequestCard | ReviewNoteCard)[]): AskThread {
  return {
    state: 'ready', error: null, appName: 'Claude',
    items: [
      { kind: 'person', id: 'm1', text: 'Make me a brief team' },
      { kind: 'assistant', id: 'a1', steps: [{ id: 's1', label: 'Checked your AI apps', status: 'done', detail: null }], text: 'Here it is.', cards: cardsInTurn, done: true, thinking: false },
    ],
  }
}

describe('AskPanel', () => {
  it('opens with what Ask can do and suggestions for where the person is, which send at a click', () => {
    const ask = controller()
    render(<AskPanel ask={ask} view="home" cards={cards()} />)
    expect(screen.getByRole('heading', { name: 'Ask LoomWatch' })).toBeInTheDocument()
    expect(screen.getByText('Uses Claude on this computer')).toBeInTheDocument()
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

  it('says why Ask cannot be used and keeps the box closed', () => {
    render(<AskPanel ask={controller({ unavailable: 'Ask needs Claude Code, Codex, Gemini CLI or OpenCode on this computer.' })} view="home" cards={cards()} />)
    expect(screen.getByText(/Ask needs Claude Code/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to Ask LoomWatch' })).toBeDisabled()
    for (const button of within(screen.getByRole('list', { name: 'Try asking' })).getAllByRole('button')) expect(button).toBeDisabled()
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
    fireEvent.click(within(card).getByRole('button', { name: /Show on canvas/ }))
    expect(actions.onShowProposal).toHaveBeenCalledWith('p1', proposal)

    rerender(<AskPanel ask={controller({ thread: threadWith(proposal) })} view="build" cards={{ ...actions, previewingId: 'p1' }} />)
    fireEvent.click(within(screen.getByRole('article', { name: 'Proposed team: Brief' })).getByRole('button', { name: 'Apply' }))
    expect(actions.onApply).toHaveBeenCalled()

    rerender(<AskPanel ask={controller({ thread: threadWith({ ...proposal, outcome: 'applied' }) })} view="build" cards={actions} />)
    expect(within(screen.getByRole('article', { name: 'Proposed team: Brief' })).getByText('Applied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show on canvas/ })).not.toBeInTheDocument()
  })

  it('waits for Start run before a run the assistant asked for, and says when it started', () => {
    const actions = cards()
    const { rerender } = render(<AskPanel ask={controller({ thread: threadWith(request) })} view="build" cards={actions} />)
    const card = screen.getByRole('article', { name: 'Run Brief?' })
    expect(within(card).getByText('Uses Claude · 2 steps')).toBeInTheDocument()
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

  it('lists what connected apps proposed, newest first, without what was already handled', () => {
    const actions = cards()
    const inbox = [
      { phase: 'ask_proposal', app: 'codex', appName: 'Codex', at: '2026-10-02T09:00:00Z', proposalId: 'old', file: 'a.yaml', name: 'Old', isNew: true },
      { phase: 'ask_proposal_outcome', app: 'codex', appName: 'Codex', at: '2026-10-02T09:01:00Z', proposalId: 'old' },
      { phase: 'ask_proposal', app: 'opencode', appName: 'OpenCode', at: '2026-10-02T09:02:00Z', proposalId: 'p9', file: 'b.yaml', name: 'Evening wrap-up', isNew: true },
    ]
    render(<AskPanel ask={controller({ inbox })} view="home" cards={actions} />)
    const section = screen.getByRole('region', { name: 'From your connected apps' })
    expect(within(section).getAllByRole('listitem')).toHaveLength(1)
    expect(section).toHaveTextContent('OpenCode proposed a new team “Evening wrap-up”')
    fireEvent.click(within(section).getByRole('button', { name: 'Show' }))
    expect(actions.onShowProposal).toHaveBeenCalledWith('p9')
  })
})

describe('AskButton', () => {
  it('says when the assistant is working and when a connected app left something', () => {
    const { rerender } = render(<AskButton ask={controller({ open: false, activity: 'Drafting the team' })} />)
    expect(screen.getByRole('button', { name: 'Ask LoomWatch (Drafting the team)' })).toHaveAttribute('aria-pressed', 'false')
    rerender(<AskButton ask={controller({ open: true, inboxUnseen: 2 })} />)
    expect(screen.getByRole('button', { name: 'Ask LoomWatch, 2 new from your connected apps' })).toHaveAttribute('aria-pressed', 'true')
  })
})
