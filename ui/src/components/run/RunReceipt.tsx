import { ArrowRight, Check, ClipboardCopy } from 'lucide-react'
import { useState } from 'react'

import { RECEIPT_MARK, receiptMarkdown, type Receipt } from '../../lib/story/receipt'
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
        </dl>
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
