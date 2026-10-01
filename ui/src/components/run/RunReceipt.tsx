import { ArrowRight, Check, ClipboardCopy, Network } from 'lucide-react'
import { useState } from 'react'

import { RECEIPT_MARK, receiptMarkdown, type Receipt } from '../../lib/story/receipt'
import { LoomMark } from '../ui/glyphs'

interface RunReceiptProps {
  receipt: Receipt
  onInspectEvidence: (id: string) => void
  onSelectAgent: (id: string) => void
  onTrace: () => void
}

/**
 * The run receipt (lib/story/receipt.ts): the whole run on one slip, in the order a person checks
 * it. A newcomer reads it top to bottom in ten seconds; an expert opens any line's evidence or
 * copies the slip into a pull request as proof of what ran.
 */
export function RunReceipt({ receipt, onInspectEvidence, onSelectAgent, onTrace }: RunReceiptProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(receiptMarkdown(receipt))
      setCopied('Copied as Markdown')
    } catch {
      setCopied('Copy unavailable here')
    }
  }
  const open = (line: { evidenceId?: string; agentId?: string }) => {
    if (line.evidenceId) onInspectEvidence(line.evidenceId)
    else if (line.agentId) onSelectAgent(line.agentId)
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
              <span>{line.text}</span>
              {(line.evidenceId || line.agentId) && (
                <button type="button" className="receipt-open" aria-label={line.evidenceId ? `Open the record: ${line.text}` : `Show this helper’s work: ${line.text}`} title={line.evidenceId ? 'Open the record' : 'Show this helper’s work'} onClick={() => open(line)}><ArrowRight size={12} aria-hidden="true" /></button>
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
                    {(line.evidenceId || line.agentId) && <button type="button" className="receipt-open" aria-label={`Open: ${line.text}`} onClick={() => open(line)}><ArrowRight size={12} aria-hidden="true" /></button>}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
        <footer className="receipt-foot">
          <button type="button" className="btn" onClick={() => void copy()}>{copied === 'Copied as Markdown' ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}Copy as Markdown</button>
          <button type="button" className="btn" onClick={onTrace}><Network size={14} aria-hidden="true" />See every event</button>
          <span role="status" className="receipt-status">{copied && copied !== 'Copied as Markdown' ? copied : ''}</span>
        </footer>
      </div>
    </section>
  )
}
