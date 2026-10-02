import { AlertCircle, ArrowUp, Check, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent } from 'react'

import type { AskContext, InboxItem } from '../../lib/ask/client'
import type { AskStep, AssistantTurn } from '../../lib/ask/thread'
import type { AskController } from '../../lib/ask/useAsk'
import { Markdown } from '../ui/Markdown'
import { AskAppPicker } from './AskAppPicker'
import { AskCardView, type CardActions } from './AskCards'

const SUGGESTIONS: Record<AskContext['view'], string[]> = {
  home: [
    'Make a team that writes me a short AI news brief every weekday morning',
    'Set up a team to research a topic and write a one-page summary',
    'Which teams do I have, and what do they do?',
  ],
  build: [
    'Add a fact-checker before the last step',
    'Explain what this team does, step by step',
    'Run this team now',
  ],
  run: [
    'What is this run doing right now?',
    'Draft a note for the review step',
    'Why did this run stop?',
  ],
}

const PLACEHOLDER: Record<AskContext['view'], string> = {
  home: 'Describe the job, in your own words',
  build: 'Ask for a change, or say “run it”',
  run: 'Ask about this run',
}

function StepIcon({ status }: { status: AskStep['status'] }) {
  if (status === 'running') return <Loader2 className="ask-step-spin" size={13} aria-hidden="true" />
  if (status === 'failed') return <AlertCircle size={13} aria-hidden="true" />
  return <Check className="ask-step-check" size={13} aria-hidden="true" />
}

function Steps({ steps }: { steps: AskStep[] }) {
  if (steps.length === 0) return null
  return (
    <ol className="ask-steps" aria-label="What the assistant did">
      {steps.map((step) => (
        <li key={step.id} className={`ask-step is-${step.status}`}>
          <StepIcon status={step.status} />
          <span>
            {step.label}
            {step.status === 'failed' && step.detail && <small>{step.detail}</small>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Reply({ turn, cards }: { turn: AssistantTurn; cards: CardActions }) {
  if (turn.steps.length === 0 && !turn.text && turn.cards.length === 0) return null
  return (
    <li className="ask-turn">
      <Steps steps={turn.steps} />
      {turn.text && <div className="ask-reply"><Markdown>{turn.text}</Markdown></div>}
      {turn.cards.map((card) => <AskCardView key={`${card.kind}:${card.id}`} card={card} actions={cards} />)}
    </li>
  )
}

function inboxLine(item: InboxItem): string {
  if (item.phase === 'ask_proposal') return `${item.appName} proposed ${item.isNew ? 'a new team' : 'changes to'} “${item.name || item.file}”`
  if (item.phase === 'ask_run_started') return `${item.appName} started a run of ${item.file}`
  if (item.phase === 'ask_review_note') return `${item.appName} drafted a note for ${item.file}`
  return `${item.appName} used LoomWatch`
}

function Inbox({ items, cards }: { items: InboxItem[]; cards: CardActions }) {
  // A proposal the person already applied or discarded has nothing left to do here.
  const handled = new Set(items.filter((item) => item.phase === 'ask_proposal_outcome').map((item) => item.proposalId))
  const shown = items
    .filter((item) => item.phase !== 'ask_proposal_outcome' && !(item.proposalId && handled.has(item.proposalId)))
    .slice(-3).reverse()
  if (shown.length === 0) return null
  return (
    <section className="ask-inbox" aria-label="From your connected apps">
      <h3 className="t-micro">From your connected apps</h3>
      <ul>
        {shown.map((item) => (
          <li key={`${item.phase}:${item.at}`}>
            <span>{inboxLine(item)}</span>
            {item.phase === 'ask_proposal' && item.proposalId && <button type="button" className="link" onClick={() => cards.onShowProposal(item.proposalId as string)}>Show</button>}
            {item.phase === 'ask_run_started' && item.runId && item.file && <button type="button" className="link" onClick={() => cards.onOpenRun(item.runId as string, item.file as string)}>Watch</button>}
            {item.phase === 'ask_review_note' && item.runId && item.file && item.text && (
              <button type="button" className="link" onClick={() => cards.onUseNote({ kind: 'review-note', id: item.at, runId: item.runId as string, file: item.file as string, name: '', question: item.question ?? '', text: item.text as string })}>Use note</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface AskPanelProps {
  ask: AskController
  view: AskContext['view']
  cards: CardActions
  /** Another panel holds the right-hand side; the conversation waits behind it. */
  hidden?: boolean
  /** On Home, where there is no zoom bar to stop above. */
  onHome?: boolean
}

/**
 * Ask LoomWatch: a conversation with one of the person's own AI apps, which sets up, changes, runs
 * and reviews teams through LoomWatch's tools (ADR 0033). What it makes is shown, never done: a team
 * arrives on the canvas to apply, a run waits for Start, a review note goes in the box unsent.
 */
export function AskPanel({ ask, view, cards, hidden = false, onHome = false }: AskPanelProps) {
  const titleId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const { thread } = ask
  const items = thread.items
  const working = ask.activity !== null
  const finished = ask.ended || thread.state === 'ended' || thread.state === 'failed'
  const empty = items.length === 0 && !ask.pending

  useEffect(() => {
    if (hidden) return
    input.current?.focus()
  }, [ask.focusRequest, hidden])

  // Follow the conversation as it grows, unless the person has scrolled up to read.
  const lastLength = useRef(0)
  const shape = `${items.length}:${ask.pending ?? ''}:${ask.activity ?? ''}:${items.at(-1)?.kind === 'assistant' ? (items.at(-1) as AssistantTurn).text.length + (items.at(-1) as AssistantTurn).cards.length * 1000 + (items.at(-1) as AssistantTurn).steps.length : 0}`
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    // Measured against the height before this change: whoever was reading the end keeps reading it.
    const wasAtEnd = lastLength.current - element.scrollTop - element.clientHeight < 160
    if ((wasAtEnd || lastLength.current === 0) && typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior: lastLength.current === 0 ? 'auto' : 'smooth' })
    lastLength.current = element.scrollHeight
  }, [shape])

  useEffect(() => {
    if (!hidden && ask.open && ask.inboxUnseen > 0) ask.markInboxSeen()
  }, [hidden, ask])

  const submit = () => {
    const text = ask.draft
    if (!text.trim() || working || ask.sending) return
    ask.setDraft('')
    void ask.send(text).then((sent) => { if (!sent) ask.setDraft(text) })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  if (hidden) return null
  // A live conversation keeps the app and model it started with; otherwise the next one's are shown.
  const liveApp = !finished && thread.appId ? ask.apps?.apps.find((app) => app.id === thread.appId) : undefined
  const shownApp = liveApp ?? ask.selectedApp
  const shownModel = liveApp
    ? thread.model ? (thread.model === ask.selectedModel?.id ? ask.selectedModel : { id: thread.model, name: thread.model }) : null
    : ask.selectedModel

  return (
    <aside className={`ask-panel ${onHome ? 'on-home' : ''}`} aria-labelledby={titleId} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); ask.setOpen(false) } }}>
      <div className="ask-glass" aria-hidden="true" />
      <header className="ask-head">
        <div className="ask-head-text">
          <h2 id={titleId}>Ask LoomWatch</h2>
          {ask.unavailable
            ? <p className="unavailable">{ask.unavailable}</p>
            : shownApp && ask.apps
              ? (
                // A div, not a p: the picker's list opens inside it.
                <div className="ask-app-line">
                  Using{' '}
                  <AskAppPicker
                    apps={ask.apps.apps}
                    app={shownApp}
                    model={shownModel}
                    inConversation={items.length > 0 && !finished}
                    disabled={ask.sending}
                    onChoose={ask.chooseApp}
                  />
                  {' '}on this computer
                </div>
              )
              : <p>{thread.appName ? `Using ${thread.appName} on this computer` : 'Looking for an AI app…'}</p>}
        </div>
        {items.length > 0 && <button type="button" className="iconbtn" onClick={ask.startOver} aria-label="Start a new conversation" title="New conversation"><RotateCcw size={15} aria-hidden="true" /></button>}
        <button type="button" className="iconbtn" onClick={() => ask.setOpen(false)} aria-label="Close Ask LoomWatch" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>

      <div className="ask-scroll" ref={scroller}>
        <Inbox items={ask.inbox} cards={cards} />
        {empty ? (
          <div className="ask-empty">
            <p className="ask-empty-title">What should your team do?</p>
            <p className="ask-empty-text">I can set up a team, change one, start a run, or help you review one. Nothing is saved or run until you say so.</p>
            <ul className="ask-suggestions" aria-label="Try asking">
              {SUGGESTIONS[view].map((suggestion, index) => (
                <li key={suggestion} style={{ ['--i' as string]: index }}>
                  <button type="button" disabled={Boolean(ask.unavailable) || ask.sending} onClick={() => void ask.send(suggestion)}>{suggestion}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="ask-thread" role="log" aria-label="Conversation" aria-live="polite">
            {items.map((item) => item.kind === 'person'
              ? <li key={item.id} className="ask-you"><p>{item.text}</p></li>
              : <Reply key={item.id} turn={item} cards={cards} />)}
            {ask.pending && <li className="ask-you pending"><p>{ask.pending}</p></li>}
          </ol>
        )}
        {working && (
          <p className="ask-activity" role="status">
            <span className="ask-dots" aria-hidden="true"><i /><i /><i /></span>
            {ask.activity}…
          </p>
        )}
        {thread.state === 'failed' && thread.error && (
          <div role="alert" className="ask-problem">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{thread.error}</span>
            <button type="button" className="link" onClick={ask.startOver}>Start again</button>
          </div>
        )}
        {finished && thread.state !== 'failed' && items.length > 0 && <p className="ask-ended t-meta">This conversation has ended. Your next message starts a new one.</p>}
        {ask.error && (
          <div role="alert" className="ask-problem">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{ask.error}</span>
            <button type="button" className="link" onClick={ask.dismissError}>Dismiss</button>
          </div>
        )}
      </div>

      <form className="ask-compose" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="ask-input">
          <textarea
            ref={input}
            rows={1}
            value={ask.draft}
            onChange={(event) => ask.setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={PLACEHOLDER[view]}
            aria-label="Message to Ask LoomWatch"
            maxLength={8000}
            disabled={Boolean(ask.unavailable)}
          />
          <button type="submit" className="ask-send" aria-label="Send" title="Send (↵)" disabled={!ask.draft.trim() || working || ask.sending || Boolean(ask.unavailable)}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="ask-switch">
          <input type="checkbox" role="switch" checked={ask.askBeforeRun} onChange={(event) => ask.setAskBeforeRun(event.target.checked)} />
          <span className="ask-switch-track" aria-hidden="true"><i /></span>
          <span>Ask me before starting a run</span>
        </label>
      </form>
    </aside>
  )
}
