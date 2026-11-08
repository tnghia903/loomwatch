import { ArrowRight, Check, PenLine, Play } from '../ui/icon'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { agentProposalLines, savedSinceAsk } from '../../lib/ask/agentProposal'
import { proposalChanges } from '../../lib/ask/proposal'
import { changedSinceAsk, skillProposalLines, skillProposalName } from '../../lib/ask/skillProposal'
import type { AgentProposalCard, AskCard, ProposalCard, ReviewNoteCard, RunRequestCard, RunStartedCard, SkillProposalCard } from '../../lib/ask/thread'
import { useSavedJobs } from '../../lib/library/jobs'
import { SKILLS_CHANGED_EVENT } from '../../lib/library/client'
import { readSkillWords, SkillsApiError, type SkillWords } from '../../lib/library/skillStore'
import { SaidText } from '../chat/SaidText'
import { SkillSheet, type Writing } from '../skills/SkillSheet'
import { InlineMarkdown } from '../ui/Markdown'

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
  /** An agent Ask proposed (ADR 0119): open it on its page, where Save keeps it. */
  onOpenAgent: (card: AgentProposalCard) => void
  onDiscardAgent: (card: AgentProposalCard) => void
  /** A skill Ask proposed (ADR 0121), saved on the Skills page's sheet or discarded on its card. */
  onSkillSettled: (card: SkillProposalCard, outcome: 'applied' | 'discarded') => void
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
  const changes = useMemo(() => proposalChanges(card.isNew ? null : actions.savedYamlFor(card.file), card.yaml, card.agentNames), [card, actions])
  const showing = actions.previewingId === card.id
  if (card.superseded && !card.outcome) {
    return <div className="ask-card ask-card-quiet t-meta">An earlier draft of “{card.name}”, replaced by the one below.</div>
  }
  const settledText = card.outcome === 'applied' ? 'Applied' : card.outcome === 'undone' ? 'Applied, then undone' : card.outcome === 'discarded' ? 'Discarded' : null
  // What it changes, while there is still a choice to make; afterwards the outcome says enough.
  const lines = !card.outcome && (card.isNew || actions.savedYamlFor(card.file) !== null) ? changes.lines : []
  return (
    <article className={`ask-card ask-proposal ${card.outcome ? `is-${card.outcome}` : 'is-open'} ${showing ? 'is-showing' : ''}`} data-tour={card.outcome || showing ? undefined : 'ask-proposal'} aria-label={`Proposed team: ${card.name}`}>
      {!card.outcome && <DashedEdge />}
      <header className="ask-card-head">
        <span className="t-micro">{card.isNew ? 'New team' : 'Changes'}</span>
        <span className="ask-card-file t-mono-sm" title={card.file}>{card.file}</span>
      </header>
      <strong className="ask-card-title">{card.name}</strong>
      {card.project && <p className="ask-card-text">{card.project.isNew ? `New project: ${card.project.name}` : `In ${card.project.name}`}</p>}
      {card.summary && <p className="ask-card-text"><InlineMarkdown>{card.summary}</InlineMarkdown></p>}
      {lines.length > 0 && <ul className="ask-card-lines">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      {settledText ? (
        <p className={`ask-card-outcome ${card.outcome === 'applied' ? 'ok' : ''}`}>{card.outcome === 'applied' && <Check size={14} aria-hidden="true" />}{settledText}</p>
      ) : showing ? (
        <div className="ask-card-acts">
          <span className="ask-card-hint">On the canvas now. Nothing is saved until you apply it.</span>
          <button type="button" className="btn btn-act" data-tour="apply-proposal" onClick={actions.onApply}>Apply</button>
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

/**
 * One agent Ask proposed on its own (ADR 0119): what it starts with, or what the change changes and
 * which teams get it. Open shows it on its page as a draft, where the page's own Save keeps it.
 */
function AgentProposalView({ card, actions }: { card: AgentProposalCard; actions: CardActions }) {
  const { jobs } = useSavedJobs()
  const saved = card.agent ? jobs.find((job) => job.id === card.agent) ?? null : null
  // Saved again since Ask read it: the change was made from another version and can't be saved.
  const stale = !card.outcome && savedSinceAsk(card, saved)
  const lines = useMemo(() => (card.outcome || stale ? [] : agentProposalLines(card, saved)), [card, saved, stale])
  if (card.superseded && !card.outcome) {
    return <div className="ask-card ask-card-quiet t-meta">An earlier draft of “{card.name}”, replaced by the one below.</div>
  }
  const settledText = card.outcome === 'applied' ? 'Saved' : card.outcome === 'discarded' ? 'Discarded' : null
  const error = actions.cardError?.id === card.id ? actions.cardError.message : null
  return (
    <article className={`ask-card ask-proposal ask-agent-proposal ${card.outcome ? `is-${card.outcome}` : 'is-open'}`} aria-label={`${card.isNew ? 'Proposed agent' : 'Proposed change to'} ${card.name}`}>
      {!card.outcome && <DashedEdge />}
      <header className="ask-card-head"><span className="t-micro">{card.isNew ? 'New agent' : 'Changes'}</span></header>
      <strong className="ask-card-title">{card.name}</strong>
      {card.summary && <p className="ask-card-text"><InlineMarkdown>{card.summary}</InlineMarkdown></p>}
      {lines.length > 0 && <ul className="ask-card-lines">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      {error && <p role="alert" className="ask-card-error">{error}</p>}
      {settledText ? (
        <p className={`ask-card-outcome ${card.outcome === 'applied' ? 'ok' : ''}`}>{card.outcome === 'applied' && <Check size={14} aria-hidden="true" />}{settledText}</p>
      ) : stale ? (
        <div className="ask-card-acts">
          <span className="ask-card-hint">{card.name} was saved again after Ask read it. Ask again for a new change.</span>
          <button type="button" className="btn" disabled={actions.busyCard === card.id} onClick={() => actions.onDiscardAgent(card)}>Discard</button>
        </div>
      ) : (
        <div className="ask-card-acts">
          <button type="button" className="btn btn-act" onClick={() => actions.onOpenAgent(card)}>Open<ArrowRight size={14} aria-hidden="true" /></button>
          <button type="button" className="btn" disabled={actions.busyCard === card.id} onClick={() => actions.onDiscardAgent(card)}>Discard</button>
          <span className="ask-card-hint">Nothing is saved until you press {card.isNew ? 'Save to My agents' : 'Save'} on its page.</span>
        </div>
      )}
    </article>
  )
}

/** The skill a change is for, as it is saved now: null while it loads, `gone` when it isn't there. */
function useSkillWords(name: string | null): SkillWords | 'gone' | null {
  const [words, setWords] = useState<{ name: string; read: SkillWords | 'gone' } | null>(null)
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    if (!name) return
    // A save anywhere in the app, this card's own included, may change the skill.
    const again = () => setTurn((value) => value + 1)
    window.addEventListener(SKILLS_CHANGED_EVENT, again)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, again)
  }, [name])
  useEffect(() => {
    if (!name) return
    let active = true
    readSkillWords(name).then(
      (read) => { if (active) setWords({ name, read }) },
      // Not knowing (the daemon away) is not the same as gone: the sheet says what went wrong.
      (caught: unknown) => { if (active && caught instanceof SkillsApiError && caught.status === 404) setWords({ name, read: 'gone' }) },
    )
    return () => { active = false }
  }, [name, turn])
  return words && words.name === name ? words.read : null
}

/**
 * A skill Ask proposed (ADR 0121): when agents use a new one, or what a change changes and who it
 * changes it for. Open shows it on the Skills page's own sheet, over this screen, where Save skill
 * keeps it; for a change, what Ask took out and put in is marked there, with Put back.
 */
function SkillProposalView({ card, actions }: { card: SkillProposalCard; actions: CardActions }) {
  const [open, setOpen] = useState(false)
  // Saved here: shown at once, whether or not the daemon could still record it.
  const [saved, setSaved] = useState(false)
  const words = useSkillWords(card.isNew || card.outcome || saved ? null : card.skill)
  const now = words === 'gone' ? null : words
  const stale = !card.outcome && !saved && changedSinceAsk(card, now)
  const gone = !card.outcome && !saved && words === 'gone'
  const lines = useMemo(() => (card.outcome || saved || stale || gone ? [] : skillProposalLines(card, now)), [card, saved, stale, gone, now])
  const name = skillProposalName(card)
  // A later draft replaces the card, but not a sheet the person has open on this one.
  if (card.superseded && !card.outcome && !open) {
    return <div className="ask-card ask-card-quiet t-meta">An earlier draft of “{name}”, replaced by the one below.</div>
  }
  const outcome = saved ? 'applied' : card.outcome
  const settledText = outcome === 'applied' ? 'Saved' : outcome === 'discarded' ? 'Discarded' : null
  const error = actions.cardError?.id === card.id ? actions.cardError.message : null
  const busy = actions.busyCard === card.id
  // Where the sheet gives focus back once Open is gone, after a save: this card, which says Saved.
  const landing = !card.outcome || saved
  const writing: Writing = card.isNew
    ? { kind: 'new', start: { title: card.title ?? name, description: card.description, instructions: card.instructions } }
    : { kind: 'change', name: card.skill, proposed: { description: card.description, instructions: card.instructions, ...(card.base ? { base: card.base } : {}) } }
  return (
    <article
      className={`ask-card ask-proposal ask-skill-proposal ${outcome ? `is-${outcome}` : 'is-open'}`}
      aria-label={`${card.isNew ? 'Proposed skill' : 'Proposed change to'} ${name}`}
      tabIndex={landing ? -1 : undefined}
      data-ask-card={card.id}
    >
      {!outcome && <DashedEdge />}
      <header className="ask-card-head"><span className="t-micro">{card.isNew ? 'New skill' : 'Changes'}</span></header>
      <strong className="ask-card-title">{name}</strong>
      {card.summary && <p className="ask-card-text"><InlineMarkdown>{card.summary}</InlineMarkdown></p>}
      {lines.length > 0 && <ul className="ask-card-lines">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      {error && <p role="alert" className="ask-card-error">{error}</p>}
      {settledText ? (
        <p className={`ask-card-outcome ${outcome === 'applied' ? 'ok' : ''}`}>{outcome === 'applied' && <Check size={14} aria-hidden="true" />}{settledText}</p>
      ) : stale || gone ? (
        <div className="ask-card-acts">
          <span className="ask-card-hint">{gone ? `${name} isn’t in your skills any more.` : `${name} was changed after Ask read it. Ask again for a new change.`}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => actions.onSkillSettled(card, 'discarded')}>Discard</button>
        </div>
      ) : (
        <div className="ask-card-acts">
          <button type="button" className="btn btn-act" onClick={() => setOpen(true)}>Open<ArrowRight size={14} aria-hidden="true" /></button>
          <button type="button" className="btn" disabled={busy} onClick={() => actions.onSkillSettled(card, 'discarded')}>Discard</button>
          <span className="ask-card-hint">Nothing is saved until you press Save skill.</span>
        </div>
      )}
      {open && createPortal(
        <SkillSheet
          writing={writing}
          returnFocus={landing ? `[data-ask-card=${JSON.stringify(card.id)}]` : undefined}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); setSaved(true); actions.onSkillSettled(card, 'applied') }}
        />,
        document.body,
      )}
    </article>
  )
}

function RunRequestView({ card, actions }: { card: RunRequestCard; actions: CardActions }) {
  const busy = actions.busyCard === card.id
  const error = actions.cardError?.id === card.id ? actions.cardError.message : null
  const uses = card.steps > 0 ? `${card.steps} step${card.steps === 1 ? '' : 's'}` : ''
  return (
    <article className={`ask-card ask-run-request ${card.decision ? `is-${card.decision}` : 'is-open'}`} aria-label={`Run ${card.name}?`}>
      <header className="ask-card-head"><span className="t-micro">{card.decision === 'started' ? 'Run started' : card.decision === 'declined' ? 'Not run' : 'Ready to run'}</span></header>
      <strong className="ask-card-title">{card.name}</strong>
      <blockquote className="ask-card-quote"><SaidText text={card.request} /></blockquote>
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
      {card.request && <blockquote className="ask-card-quote"><SaidText text={card.request} /></blockquote>}
      <div className="ask-card-acts"><button type="button" className="btn btn-act" onClick={() => actions.onOpenRun(card.runId, card.file)}>Watch the run<ArrowRight size={14} aria-hidden="true" /></button></div>
    </article>
  )
}

function ReviewNoteView({ card, actions }: { card: ReviewNoteCard; actions: CardActions }) {
  return (
    <article className="ask-card ask-review-note" aria-label="Drafted review note">
      <header className="ask-card-head"><span className="t-micro">Waiting for you</span>{card.name && <span className="ask-card-file">at “{card.name}”</span>}</header>
      {card.question && <p className="ask-card-text"><InlineMarkdown>{card.question}</InlineMarkdown></p>}
      <blockquote className="ask-card-quote"><SaidText text={card.text} /></blockquote>
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
    case 'agent-proposal': return <AgentProposalView card={card} actions={actions} />
    case 'skill-proposal': return <SkillProposalView card={card} actions={actions} />
    case 'run-request': return <RunRequestView card={card} actions={actions} />
    case 'run-started': return <RunStartedView card={card} actions={actions} />
    case 'review-note': return <ReviewNoteView card={card} actions={actions} />
  }
}
