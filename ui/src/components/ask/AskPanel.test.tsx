import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AskApp } from '../../lib/ask/client'

import { EMPTY_THREAD, type AskThread, type ProposalCard, type ReviewNoteCard, type RunRequestCard } from '../../lib/ask/thread'
import type { AskController } from '../../lib/ask/useAsk'
import type { CardActions } from './AskCards'
import { AskButton } from './AskButton'
import { AskPanel } from './AskPanel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CLAUDE: AskApp = { id: 'claude', name: 'Claude', available: true, reason: null }
const CODEX: AskApp = { id: 'codex', name: 'Codex', available: true, reason: null }
const GEMINI: AskApp = { id: 'gemini', name: 'Gemini', available: false, reason: 'gemini is not signed in' }

function controller(overrides: Partial<AskController> = {}): AskController {
  return {
    open: true, setOpen: vi.fn(), apps: { apps: [CLAUDE, CODEX, GEMINI], defaultApp: 'claude' },
    selectedApp: CLAUDE, selectedModel: null, chooseApp: vi.fn(),
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
    state: 'ready', error: null, appName: 'Claude', appId: 'claude', model: null,
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
    expect(screen.getByRole('button', { name: 'AI app: Claude. Change' }).closest('.ask-app-line')).toHaveTextContent('Using Claude on this computer')
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

describe('Choosing the AI app', () => {
  function stubModels() {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/harnesses/claude/models') {
        return new Response(JSON.stringify({
          harnessId: 'claude', currentModelId: 'default',
          models: [
            { id: 'default', name: 'Default (recommended)', thinkingEfforts: [] },
            { id: 'opus', name: 'Opus', thinkingEfforts: [] },
            { id: 'haiku', name: 'Haiku', thinkingEfforts: [] },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: `unknown harness ${url}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('lists the apps Ask can use, and an app that cannot run here is shown but not offered', async () => {
    stubModels()
    const ask = controller()
    render(<AskPanel ask={ask} view="home" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI app: Claude. Change' }))
    const apps = within(screen.getByRole('group', { name: 'AI app' }))
    expect(apps.getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true')
    const gemini = apps.getByRole('button', { name: /Gemini/ })
    expect(gemini).toBeDisabled()
    expect(gemini).toHaveTextContent('Can’t run here')
    expect(gemini).toHaveAttribute('title', 'gemini is not signed in')
    fireEvent.click(apps.getByRole('button', { name: 'Codex' }))
    expect(ask.chooseApp).toHaveBeenCalledWith('codex', null)
    // Choosing an app keeps the list open, for its models.
    expect(screen.getByRole('dialog', { name: 'Choose the AI app Ask uses' })).toBeInTheDocument()
    // No conversation yet, so nothing warns about starting a new one.
    expect(screen.queryByText(/starts a new conversation/)).not.toBeInTheDocument()
  })

  it('offers the app’s models, its default first, and closes on a choice', async () => {
    stubModels()
    const ask = controller()
    render(<AskPanel ask={ask} view="build" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI app: Claude. Change' }))
    const models = within(screen.getByRole('group', { name: 'Model' }))
    const opus = await models.findByRole('button', { name: 'Opus' })
    expect(models.getByRole('button', { name: /Its default/ })).toHaveTextContent('Default (recommended)')
    // The app's current model is "Its default", so it is not listed twice.
    expect(models.queryByRole('button', { name: 'Default (recommended)' })).not.toBeInTheDocument()
    fireEvent.click(opus)
    expect(ask.chooseApp).toHaveBeenCalledWith('claude', { id: 'opus', name: 'Opus' })
    expect(screen.queryByRole('dialog', { name: 'Choose the AI app Ask uses' })).not.toBeInTheDocument()
  })

  it('names the chosen model, and says a change starts a new conversation', () => {
    stubModels()
    render(<AskPanel ask={controller({ selectedModel: { id: 'opus', name: 'Opus' }, thread: { ...threadWith(), model: 'opus' } })} view="build" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI app: Claude · Opus. Change' }))
    expect(screen.getByText('Changing the app or model starts a new conversation.')).toBeInTheDocument()
  })

  it('shows the app a live conversation started with, even when another is chosen for the next one', () => {
    render(<AskPanel ask={controller({ selectedApp: CLAUDE, thread: { ...threadWith(), appName: 'Codex', appId: 'codex', model: 'gpt-5.5' } })} view="build" cards={cards()} />)
    expect(screen.getByRole('button', { name: 'AI app: Codex · gpt-5.5. Change' })).toBeInTheDocument()
  })

  it('cannot be changed while a message is on its way', () => {
    render(<AskPanel ask={controller({ sending: true })} view="build" cards={cards()} />)
    expect(screen.getByRole('button', { name: 'AI app: Claude. Change' })).toBeDisabled()
  })

  it('says it could not list the models and keeps the default', async () => {
    stubModels()
    render(<AskPanel ask={controller({ selectedApp: CODEX })} view="build" cards={cards()} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI app: Codex. Change' }))
    expect(await screen.findByText('Codex will use its own default. LoomWatch couldn’t list its other models.')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Model' })).getByRole('button', { name: /Its default/ })).toHaveAttribute('aria-pressed', 'true')
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
