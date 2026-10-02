import { ArrowRight, Check, PenLine, Play } from 'lucide-react'
import { useMemo } from 'react'

import { proposalChanges } from '../../lib/ask/proposal'
import type { AskCard, ProposalCard, ReviewNoteCard, RunRequestCard, RunStartedCard } from '../../lib/ask/thread'

export interface CardActions {
  /** The proposal now on the canvas, if any. */
  previewingId: string | null
  /** The saved YAML of the team a proposal is for, when that team is open; null otherwise. */
  savedYamlFor: (file: string) => string | null
  busyCard: string | null
  cardError: { id: string; message: string } | null
  /** With the card when there is one, whose recorded file stands in if the daemon lost the proposal. */
  onShowProposal: (id: string, card?: ProposalCard) => void
  onApply: () => void
  onDiscard: () => void
  onStartRun: (card: RunRequestCard) => void
  onDeclineRun: (card: RunRequestCard) => void
  onOpenRun: (runId: string, file: string) => void
  onUseNote: (card: ReviewNoteCard) => void
}

/** The dashed edge a proposal wears until it is applied, drawn so the dashes can travel. */
function DashedEdge() {
  return (
    <svg className="ask-dash" aria-hidden="true" preserveAspectRatio="none">
      <rect x="0" y="0" width="100%" height="100%" rx="10" ry="10" />
    </svg>
  )
}

function ProposalView({ card, actions }: { card: ProposalCard; actions: CardActions }) {
  const changes = useMemo(() => proposalChanges(card.isNew ? null : actions.savedYamlFor(card.file), card.yaml), [card, actions])
  const showing = actions.previewingId === card.id
  if (card.superseded && !card.outcome) {
    return <div className="ask-card ask-card-quiet t-meta">An earlier draft of “{card.name}”, replaced by the one below.</div>
  }
  const settledText = card.outcome === 'applied' ? 'Applied' : card.outcome === 'undone' ? 'Applied, then undone' : card.outcome === 'discarded' ? 'Discarded' : null
  // What it changes, while there is still a choice to make; afterwards the outcome says enough.
  const lines = !card.outcome && (card.isNew || actions.savedYamlFor(card.file) !== null) ? changes.lines : []
  return (
    <article className={`ask-card ask-proposal ${card.outcome ? `is-${card.outcome}` : 'is-open'} ${showing ? 'is-showing' : ''}`} aria-label={`Proposed team: ${card.name}`}>
      {!card.outcome && <DashedEdge />}
      <header className="ask-card-head">
        <span className="t-micro">{card.isNew ? 'New team' : 'Changes'}</span>
        <span className="ask-card-file t-mono-sm" title={card.file}>{card.file}</span>
      </header>
      <strong className="ask-card-title">{card.name}</strong>
      {card.summary && <p className="ask-card-text">{card.summary}</p>}
      {lines.length > 0 && <ul className="ask-card-lines">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      {settledText ? (
        <p className={`ask-card-outcome ${card.outcome === 'applied' ? 'ok' : ''}`}>{card.outcome === 'applied' && <Check size={14} aria-hidden="true" />}{settledText}</p>
      ) : showing ? (
        <div className="ask-card-acts">
          <span className="ask-card-hint">On the canvas now. Nothing is saved until you apply it.</span>
          <button type="button" className="btn btn-act" onClick={actions.onApply}>Apply</button>
          <button type="button" className="btn" onClick={actions.onDiscard}>Discard</button>
        </div>
      ) : (
        <div className="ask-card-acts">
          <button type="button" className="btn btn-act" onClick={() => actions.onShowProposal(card.id, card)}>Show on canvas<ArrowRight size={14} aria-hidden="true" /></button>
          <span className="ask-card-hint">Nothing is saved until you apply it.</span>
        </div>
      )}
    </article>
  )
}

function RunRequestView({ card, actions }: { card: RunRequestCard; actions: CardActions }) {
  const busy = actions.busyCard === card.id
  const error = actions.cardError?.id === card.id ? actions.cardError.message : null
  const uses = [card.apps.length > 0 ? `Uses ${card.apps.join(', ')}` : null, card.steps > 0 ? `${card.steps} step${card.steps === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
  return (
    <article className={`ask-card ask-run-request ${card.decision ? `is-${card.decision}` : 'is-open'}`} aria-label={`Run ${card.name}?`}>
      <header className="ask-card-head"><span className="t-micro">{card.decision === 'started' ? 'Run started' : card.decision === 'declined' ? 'Not run' : 'Ready to run'}</span></header>
      <strong className="ask-card-title">{card.name}</strong>
      <blockquote className="ask-card-quote">{card.request}</blockquote>
      {uses && <p className="ask-card-meta t-meta">{uses}</p>}
      {error && <p role="alert" className="ask-card-error">{error}</p>}
      {card.decision === 'started' && card.runId ? (
        <div className="ask-card-acts"><button type="button" className="btn btn-act" onClick={() => actions.onOpenRun(card.runId as string, card.file)}>Watch the run<ArrowRight size={14} aria-hidden="true" /></button></div>
      ) : card.decision === 'declined' ? (
        <p className="ask-card-outcome">You chose not to run it.</p>
      ) : (
        <div className="ask-card-acts">
          <button type="button" className="btn btn-act" disabled={busy} onClick={() => actions.onStartRun(card)}><Play size={14} aria-hidden="true" />{busy ? 'Starting…' : 'Start run'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => actions.onDeclineRun(card)}>Not now</button>
        </div>
      )}
    </article>
  )
}

function RunStartedView({ card, actions }: { card: RunStartedCard; actions: CardActions }) {
  return (
    <article className="ask-card ask-run-started" aria-label="Run started">
      <header className="ask-card-head"><span className="t-micro">Run started</span><span className="ask-card-file t-mono-sm">{card.file}</span></header>
      {card.request && <blockquote className="ask-card-quote">{card.request}</blockquote>}
      <div className="ask-card-acts"><button type="button" className="btn btn-act" onClick={() => actions.onOpenRun(card.runId, card.file)}>Watch the run<ArrowRight size={14} aria-hidden="true" /></button></div>
    </article>
  )
}

function ReviewNoteView({ card, actions }: { card: ReviewNoteCard; actions: CardActions }) {
  return (
    <article className="ask-card ask-review-note" aria-label="Drafted review note">
      <header className="ask-card-head"><span className="t-micro">Waiting for you</span>{card.name && <span className="ask-card-file">at “{card.name}”</span>}</header>
      {card.question && <p className="ask-card-text">{card.question}</p>}
      <blockquote className="ask-card-quote">{card.text}</blockquote>
      <div className="ask-card-acts">
        <button type="button" className="btn btn-act" onClick={() => actions.onUseNote(card)}><PenLine size={14} aria-hidden="true" />Put it in the review box</button>
        <span className="ask-card-hint">You read it and send it yourself.</span>
      </div>
    </article>
  )
}

export function AskCardView({ card, actions }: { card: AskCard; actions: CardActions }) {
  switch (card.kind) {
    case 'proposal': return <ProposalView card={card} actions={actions} />
    case 'run-request': return <RunRequestView card={card} actions={actions} />
    case 'run-started': return <RunStartedView card={card} actions={actions} />
    case 'review-note': return <ReviewNoteView card={card} actions={actions} />
  }
}
