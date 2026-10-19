import { ArrowRight, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { Face } from '../../lib/chat/reactions'
import { outputText, readAttempt, type Outcome } from '../../lib/story/attempt'
import { commandOf } from '../../lib/story/commands'
import { mendNote, span } from '../../lib/story/weft'
import { formatOffset, type Evidence } from '../../lib/watch/events'
import { CrewFace } from '../chat/Reactions'

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/** What a Team Bus message said, verbatim: the question, task or reason, and an answer if one came back. */
function messageWords(evidence: Evidence): [string, string][] {
  const input = evidence.rawInput && typeof evidence.rawInput === 'object' ? evidence.rawInput as Record<string, unknown> : {}
  const output = evidence.rawOutput && typeof evidence.rawOutput === 'object' ? evidence.rawOutput as Record<string, unknown> : {}
  const words: [string, string][] = []
  if (typeof input.question === 'string') words.push(['Question', input.question])
  if (typeof input.task === 'string') words.push(['Task', input.task])
  if (typeof input.reason === 'string') words.push(['Reason', input.reason])
  if (typeof output.reply === 'string') words.push([`Answer from ${evidence.target ?? 'the agent'}`, output.reply])
  return words
}

/** The crew's face for how it went, and the words beside it. Red is for what didn't work; gold is you. */
const LOOK: Record<Outcome, { face: Face; words: string; tone: 'ok' | 'bad' | 'you' | 'live' }> = {
  worked: { face: 'done', words: 'Worked', tone: 'ok' },
  allowed: { face: 'done', words: 'You allowed it', tone: 'ok' },
  fixed: { face: 'met', words: 'Fixed', tone: 'ok' },
  failed: { face: 'off', words: 'Didn’t work', tone: 'bad' },
  unclear: { face: 'hmm', words: 'Didn’t work', tone: 'bad' },
  declined: { face: 'seen', words: 'You said no', tone: 'you' },
  answered: { face: 'seen', words: 'You answered instead', tone: 'you' },
  waiting: { face: 'seen', words: 'Waiting for you', tone: 'you' },
  working: { face: 'seen', words: 'Working on it', tone: 'live' },
}

interface ActivityPanelProps {
  evidence: Evidence
  ownerLabel: string
  /** The same agent's calls, as the receipt is given them: what tells a failure the agent put right. */
  calls: readonly Evidence[]
  onInspectEvidence: (id: string) => void
  onClose: () => void
}

// Live activity uses a compact inspection panel. It is deliberately not modal: the run stays
// visible and Escape/Close returns focus to the card that opened it.
//
// It reads the call the way a newcomer would ask about it: what the agent tried, how it went (the
// crew's face, then a word), why it didn't work, and what the agent did next. The call as recorded
// (its command, output and events) waits under Technical details, open from the start only when
// its output doesn't say why in plain words.
export function ActivityPanel({ evidence, ownerLabel, calls, onInspectEvidence, onClose }: ActivityPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeButton.current?.focus() }, [evidence.id])
  const agent = ownerLabel.split(' · ')[0]
  const attempt = readAttempt(agent, evidence, calls)
  const look = LOOK[attempt.outcome]
  const mend = attempt.mend
  const said = evidence.kind === 'delegation' ? messageWords(evidence) : []
  const output = outputText(evidence)
  const at = new Date(evidence.ts)
  const rows = Boolean(attempt.targets || attempt.why || attempt.mend || attempt.then)
  return (
    <aside className={`panel right top e1 lw-activity tone-${look.tone}`} aria-labelledby="activity-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className="act-head">
        {/* The crew's face sewn onto its tile, as on LoomWatch's mark. Keyed by the call, so each
            one opened plays its face's move once. */}
        <span className="act-face" key={evidence.id}>
          <svg className="act-stitch" width="52" height="52" viewBox="0 0 52 52" aria-hidden="true"><rect x="1" y="1" width="50" height="50" rx="15" /></svg>
          <CrewFace face={look.face} size={34} />
        </span>
        <button ref={closeButton} type="button" className="iconbtn" onClick={onClose} aria-label="Close activity details" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>
      <div className="act-said">
        <h2 className="act-title t-title" id="activity-title">{attempt.sentence}</h2>
        <p className="act-state t-meta"><span className="act-word">{look.words}</span> · <time dateTime={evidence.ts} title={at.toLocaleString()}>{span(evidence.offsetMs)} into the run</time></p>
      </div>
      {rows && (
        <dl className="act-rows">
          {attempt.targets && <><dt>{attempt.targets.label}</dt><dd className="act-chips">{attempt.targets.items.map((item) => <span key={item} className="act-chip" title={item}>{item}</span>)}</dd></>}
          {attempt.why && <><dt>Why</dt><dd>{attempt.why.text}{attempt.why.code && <span className="act-code t-mono" title="The code it was told">{attempt.why.code}</span>}</dd></>}
          {mend && (
            <><dt>Then</dt><dd>
              <button type="button" className="insp-mend" onClick={() => onInspectEvidence(mend.by.id)}>
                {mendNote(mend.how, mend.by.offsetMs - evidence.offsetMs)}<ArrowRight size={12} aria-hidden="true" />
              </button>
            </dd></>
          )}
          {!mend && attempt.then && <><dt>Then</dt><dd className="act-then">{attempt.then}</dd></>}
        </dl>
      )}
      {/* A message to another agent reads as what was said, before the call that carried it. */}
      {said.map(([label, text]) => (
        <div className="zone" key={label}>
          <div className="zone-head t-micro">{label}</div>
          <p className="ent-said t-body selectable">{text}</p>
        </div>
      ))}
      <details className="act-tech" open={attempt.outcome === 'unclear'} key={`tech:${evidence.id}`}>
        <summary className="t-meta">Technical details</summary>
        <div className="act-tech-body">
          <p className="act-call t-mono-sm" title={evidence.name}>{evidence.name}</p>
          {/* A command reads as it was run, line by line, not as JSON with its line breaks escaped. */}
          {evidence.kind === 'command' ? (
            <div className="zone">
              <div className="zone-head t-micro">Command</div>
              <pre className="ent-out t-mono-sm">{commandOf(evidence)}</pre>
            </div>
          ) : evidence.rawInput !== null && evidence.rawInput !== undefined && (
            <div className="zone">
              <div className="zone-head t-micro">Input</div>
              <pre className="ent-out t-mono-sm">{pretty(evidence.rawInput)}</pre>
            </div>
          )}
          {output && (
            <div className="zone">
              <div className="zone-head t-micro">Output</div>
              <pre className="ent-out t-mono-sm">{output}</pre>
            </div>
          )}
          <div className="zone">
            <div className="zone-head t-micro">Record</div>
            <dl className="proc-list t-mono-sm">
              <dt>Owner</dt><dd>{ownerLabel}</dd>
              <dt>Relation</dt><dd>{evidence.relation}{evidence.target ? ` ${evidence.target}` : ''}</dd>
              <dt>Kind</dt><dd>{evidence.kind}{evidence.toolKind ? ` · ${evidence.toolKind}` : ''}</dd>
              <dt>Status</dt><dd>{evidence.status}</dd>
              <dt>Time</dt><dd>{at.toLocaleTimeString()} · #{String(evidence.order).padStart(2, '0')} · {formatOffset(evidence.offsetMs)} · seq {evidence.seq}</dd>
              {evidence.detail && <><dt>Detail</dt><dd>{evidence.detail}</dd></>}
              {evidence.locations.length > 0 && <><dt>Paths</dt><dd>{evidence.locations.map((location) => location.path + (location.line ? `:${location.line}` : '')).join('\n')}</dd></>}
            </dl>
          </div>
          <details>
            <summary className="t-micro">Raw events · {evidence.events.length}</summary>
            <pre className="ent-out t-mono-sm" style={{ marginTop: 8 }}>{pretty(evidence.events.map((event) => ({ seq: event.seq, kind: event.kind, ts: event.ts, payload: event.payload })))}</pre>
          </details>
          <p className="hint t-meta">Read from the run’s record. It never changes the saved team file.</p>
        </div>
      </details>
    </aside>
  )
}
