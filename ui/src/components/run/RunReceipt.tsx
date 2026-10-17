import { ArrowRight, Check, ChevronDown, ChevronRight, ClipboardCopy } from 'lucide-react'
import { useId, useState } from 'react'

import { figureStill, type FigureKind } from '../../lib/library/figures'
import { isAccessory } from '../../lib/quests/catalog'
import { RECEIPT_MARK, receiptMarkdown, type Receipt, type ReceiptOutcome, type ReceiptTokens } from '../../lib/story/receipt'
import type { AllowSwitch } from '../../lib/team-file/types'
import { AccessoryIcon } from '../agents/AccessoryArt'
import { LoomMark } from '../ui/glyphs'
import type { RunEarned } from './useRunQuests'

interface RunReceiptProps {
  receipt: Receipt
  onInspectEvidence: (id: string) => void
  /** Switch on what a refused line names, for this agent's next runs (ADR 0037). Absent when the
      team cannot be changed from here. */
  onAllow?: (agentId: string, key: AllowSwitch) => void
  /** What this run was the first to earn on a quest (lib/quests), with one sentence of why. */
  earned?: readonly RunEarned[]
}

/**
 * The run receipt (lib/story/receipt.ts): the whole run on one slip, in the order a person checks
 * it. A newcomer reads it top to bottom in ten seconds; an expert opens any line's evidence or
 * copies the slip into a pull request as proof of what ran.
 */
export function RunReceipt({ receipt, onInspectEvidence, onAllow, earned = [] }: RunReceiptProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [tokensOpen, setTokensOpen] = useState(false)
  const breakdown = useId()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(receiptMarkdown(receipt))
      setCopied('Receipt copied')
    } catch {
      setCopied('Copy unavailable here')
    }
  }
  // A line opens its record. A line about a helper alone has no link: its stage card is just
  // below, and a second way to select it was two controls for one thing (ADR 0043).
  const open = (line: { evidenceId?: string }) => {
    if (line.evidenceId) onInspectEvidence(line.evidenceId)
  }
  return (
    <section className="run-receipt" aria-label="Run receipt">
      <div className="receipt-slip">
        {/* A letterhead: which run on the left, how it ended stamped on the right. */}
        <div className="receipt-top">
          <div className="receipt-name">
            <header className="receipt-head"><LoomMark size={16} /><span>Run receipt</span></header>
            <p className="receipt-title">{receipt.run}</p>
          </div>
          <ReceiptStamp outcome={receipt.outcome} endedAt={receipt.endedAt} />
        </div>
        <hr />
        <dl className="receipt-facts">
          <dt>Asked</dt><dd title={receipt.asked}>{receipt.asked}</dd>
          <dt>Team</dt><dd>{receipt.team}</dd>
          <dt>Took</dt><dd>{receipt.took}</dd>
          <dt>Ran on</dt><dd>{receipt.ranOn}</dd>
          {receipt.tokens && (
            <>
              <dt>Tokens</dt>
              <dd>
                <button type="button" className="receipt-fold" aria-expanded={tokensOpen} aria-controls={breakdown} title={receipt.tokens.exact} onClick={() => setTokensOpen((open) => !open)}>
                  {[receipt.tokens.value, receipt.tokens.cached].filter(Boolean).join(' · ')}
                  {tokensOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                </button>
              </dd>
              {receipt.tokens.cost && <><dt>Cost</dt><dd title="What OpenRouter charged for this run’s model calls">{receipt.tokens.cost}</dd></>}
            </>
          )}
        </dl>
        {receipt.tokens && tokensOpen && <TokenBreakdown id={breakdown} tokens={receipt.tokens} />}
        <hr />
        <ul className="receipt-lines">
          {receipt.lines.map((line, index) => (
            <li key={index} className={`tone-${line.tone}`}>
              <span className="receipt-mark" aria-hidden="true">{RECEIPT_MARK[line.tone]}</span>
              <span>
                {line.text}
                {line.allow && line.agentId && (line.allowed
                  ? <span className="receipt-allowed">Allowed from the next run</span>
                  : onAllow && <button type="button" className="link receipt-allow" onClick={() => onAllow(line.agentId as string, line.allow as AllowSwitch)}>Allow from now on</button>)}
              </span>
              {line.evidenceId && (
                <button type="button" className="receipt-open" aria-label={`Open the record: ${line.text}`} title="Open the record" onClick={() => open(line)}><ArrowRight size={12} aria-hidden="true" /></button>
              )}
            </li>
          ))}
        </ul>
        {receipt.checks.length > 0 && (
          <>
            <hr />
            <div className="receipt-checks">
              <b>Worth a look</b>
              <ul>
                {receipt.checks.map((line, index) => (
                  <li key={index} className={`tone-${line.tone}`}>
                    <span>{line.text}</span>
                    {line.evidenceId && <button type="button" className="receipt-open" aria-label={`Open: ${line.text}`} onClick={() => open(line)}><ArrowRight size={12} aria-hidden="true" /></button>}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
        {earned.length > 0 && (
          <>
            <hr />
            <ReceiptEarned earned={earned} />
          </>
        )}
        <footer className="receipt-foot">
          <button type="button" className="btn" onClick={() => void copy()}>{copied === 'Receipt copied' ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}Copy receipt</button>
          <span role="status" className="receipt-status">{copied && copied !== 'Receipt copied' ? copied : ''}</span>
        </footer>
      </div>
    </section>
  )
}

/**
 * What the run earned (docs/QUESTS.md), under its lines: once, on the run that earned it. It says
 * what this run did and, in one sentence, why that works: LoomWatch configures agents, it does not
 * teach a course on them. No toast and no sound: the receipt is where you already look.
 */
function ReceiptEarned({ earned }: { earned: readonly RunEarned[] }) {
  return (
    <section className="receipt-earned" aria-label="Earned on this run">
      {earned.map(({ quest, line }) => (
        <div key={quest.item} className="receipt-earned-item">
          <span className={`receipt-earned-art ${quest.reward}`}>
            {isAccessory(quest.item)
              ? <AccessoryIcon item={quest.item} />
              : <img src={figureStill({ kind: quest.item as FigureKind, color: 'lilac' })} alt="" width={64} height={64} />}
          </span>
          <div>
            <b>{quest.reward === 'accessory' ? 'New in the wardrobe' : 'A new figure'}</b>
            <p><strong>{quest.name}.</strong> {line}</p>
            <p className="receipt-why">{quest.why}</p>
            <p className="receipt-earned-links">
              <a className="link" href="/agents">{quest.reward === 'accessory' ? 'Any agent can wear it: choose in Your agents' : 'Any agent can be one: choose in Your agents'}</a>
              <a className="link" href="/quests">See every quest</a>
            </p>
          </div>
        </div>
      ))}
    </section>
  )
}

/** "Oct 15, 2026 · 2:33 PM" in the reader's own locale; `null` when the record has no time. */
function stampDate(iso: string | null): string | null {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return null
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** The outcome across the stamp's middle: one line, or two split at the space nearest the middle. */
function stampLines(word: string): string[] {
  const upper = word.toUpperCase()
  if (upper.length <= 9 || !upper.includes(' ')) return [upper]
  const spaces = [...upper].flatMap((char, index) => (char === ' ' ? [index] : []))
  const split = spaces.reduce((best, index) => (Math.abs(index - upper.length / 2) < Math.abs(best - upper.length / 2) ? index : best))
  return [upper.slice(0, split), upper.slice(split + 1)]
}

/**
 * How the run ended, as a round rubber stamp in the slip's top corner, where a clerk stamps PAID:
 * the maker around the top, the day around the foot, the outcome across the middle. It leads
 * Details, so it is the page's heading; the drawing is ink only, and its words are read as text.
 */
function ReceiptStamp({ outcome, endedAt }: { outcome: ReceiptOutcome; endedAt: string | null }) {
  // The arcs are referenced by id, so the id must be one a URL fragment can name.
  const id = `stamp${useId().replace(/[^\w-]/g, '')}`
  const ended = stampDate(endedAt)
  const lines = stampLines(outcome.word)
  // Monospace, so a line's width is its letter count: the longest line sets one size for all.
  const size = Math.min(15, 94 / Math.max(...lines.map((line) => line.length)))
  return (
    <h1 className={`receipt-stamp tone-${outcome.tone}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <defs>
          <path id={`${id}-top`} d="M 19 60 A 41 41 0 0 1 101 60" />
          <path id={`${id}-foot`} d="M 12 60 A 48 48 0 0 0 108 60" />
        </defs>
        <circle className="stamp-rim" cx="60" cy="60" r="57" />
        <circle cx="60" cy="60" r="53" />
        <circle cx="60" cy="60" r="36" />
        <circle className="stamp-dot" cx="15.5" cy="60" r="1.6" />
        <circle className="stamp-dot" cx="104.5" cy="60" r="1.6" />
        <text className="stamp-ring"><textPath href={`#${id}-top`} startOffset="50%">LOOMWATCH</textPath></text>
        {ended && <text className="stamp-ring stamp-date"><textPath href={`#${id}-foot`} startOffset="50%">{ended.toUpperCase()}</textPath></text>}
        {lines.map((line, index) => (
          <text key={index} className="stamp-word" x="60" y={60 + (index - (lines.length - 1) / 2) * size * 1.1} fontSize={size}>{line}</text>
        ))}
      </svg>
      <span className="visually-hidden">{outcome.word}{ended && <>, <time dateTime={endedAt ?? undefined}>{ended}</time></>}</span>
    </h1>
  )
}

/** Who spent the run's tokens, and on what kind of turn: the work, or what it took to pass it on. */
function TokenBreakdown({ id, tokens }: { id: string; tokens: ReceiptTokens }) {
  return (
    <div id={id} className="receipt-tokens" role="group" aria-label="Tokens by agent and by kind of turn">
      {[{ heading: 'By agent', rows: tokens.agents }, { heading: 'By kind of turn', rows: tokens.purposes }].map(({ heading, rows }) => (
        <section key={heading}>
          <h4>{heading}</h4>
          <dl>
            {rows.map((row, index) => <div key={index}><dt>{row.label}</dt><dd title={row.exact}>{row.value}</dd></div>)}
          </dl>
        </section>
      ))}
      {tokens.estimate && <p className="receipt-tokens-note">{tokens.estimate}</p>}
    </div>
  )
}
