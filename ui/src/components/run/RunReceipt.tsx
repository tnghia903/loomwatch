import { ArrowRight, Check, ChevronDown, ChevronRight, ClipboardCopy } from 'lucide-react'
import { useId, useState } from 'react'

import { RECEIPT_MARK, receiptMarkdown, type Receipt, type ReceiptTokens } from '../../lib/story/receipt'
import type { AllowSwitch } from '../../lib/team-file/types'
import { LoomMark } from '../ui/glyphs'

interface RunReceiptProps {
  receipt: Receipt
  onInspectEvidence: (id: string) => void
  /** Switch on what a refused line names, for this agent's next runs (ADR 0037). Absent when the
      team cannot be changed from here. */
  onAllow?: (agentId: string, key: AllowSwitch) => void
}

/**
 * The run receipt (lib/story/receipt.ts): the whole run on one slip, in the order a person checks
 * it. A newcomer reads it top to bottom in ten seconds; an expert opens any line's evidence or
 * copies the slip into a pull request as proof of what ran.
 */
export function RunReceipt({ receipt, onInspectEvidence, onAllow }: RunReceiptProps) {
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
        <header className="receipt-head"><LoomMark width={30} height={13} /><span>Run receipt</span></header>
        <p className="receipt-title">{receipt.heading}</p>
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
        <footer className="receipt-foot">
          <button type="button" className="btn" onClick={() => void copy()}>{copied === 'Receipt copied' ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}Copy receipt</button>
          <span role="status" className="receipt-status">{copied && copied !== 'Receipt copied' ? copied : ''}</span>
        </footer>
      </div>
    </section>
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
