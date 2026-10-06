import { ArrowRight, CheckCircle2, ChevronDown, CircleAlert, CircleDot, Copy, Download, Share2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { answerFileName } from '../../lib/chat/format'
import type { RunRecord } from '../../lib/runs/client'
import { useNotionSend, type NotionSendState } from '../../lib/notion/useNotionSend'
import type { AnswerCheck } from '../../lib/story/answerCheck'
import type { ReceiptLine } from '../../lib/story/receipt'
import type { VerdictTone } from '../../lib/story/verdict'
import { NotionOffer, NotionOutcome } from '../run/NotionSend'
import { FileCard } from '../ui/FileCard'

/** Each verdict differs by glyph as well as colour; `live` wears a dot from CSS instead. */
const VERDICT_ICON: Record<VerdictTone, ReactNode> = {
  ok: <CheckCircle2 size={13} aria-hidden="true" />,
  look: <CircleDot size={13} aria-hidden="true" />,
  bad: <CircleAlert size={13} aria-hidden="true" />,
  live: null,
}

interface AnswerToolsProps {
  run: RunRecord
  /** The answer as the agent wrote it: what is copied, saved and sent. */
  answer: string
  /** What its record says about it, once the record has been read; `null` until then. */
  check: AnswerCheck | null
  /** Files the answer names, ready to open. */
  files: readonly string[]
  makers: readonly { id: string; name: string }[]
  /** A finished answer: copying, saving and sending are offered only then. */
  finished: boolean
  /** You marked it reviewed while this chat was open. */
  reviewed: boolean
  onReviewed: () => void
  /** A finding's record, opened in Details beside the chat. */
  onOpenFinding: (line: ReceiptLine) => void
}

/** Past this many files, the rest wait behind "N more" so the chat stays a chat. */
const FILES_SHOWN = 3

/**
 * Everything about a team's answer, under the answer (ADR 0051): whether its record holds anything
 * to check, the files it names — attached, as files posted in a chat are — and copy, save and send.
 * Details is the record of how the answer was made and carries no second copy of it, so each of
 * these lives here, once. Kept to one quiet row: the verdict, Copy, and Share for the rest; where
 * the answer went in Notion is said beside them once it has gone somewhere.
 */
export function AnswerTools({ run, answer, check, files, makers, finished, reviewed, onReviewed, onOpenFinding }: AnswerToolsProps) {
  const [copied, setCopied] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const notion = useNotionSend(run, finished && Boolean(answer.trim()))
  const verdict = check?.verdict ?? null
  const copy = () => { void navigator.clipboard?.writeText(answer).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }) }
  const save = () => saveAnswer(answer, run.createdAt)
  return (
    <>
      {files.length > 0 && (
        <div className="delivery-files tc-files" role="group" aria-label="Files in this answer">
          {(allFiles ? files : files.slice(0, FILES_SHOWN)).map((path) => <FileCard key={path} path={path} compact agents={makers} />)}
          {files.length > FILES_SHOWN && (
            <button type="button" className="tc-link tc-files-more" aria-expanded={allFiles} onClick={() => setAllFiles((value) => !value)}>
              {allFiles ? 'Show fewer files' : `${files.length - FILES_SHOWN} more ${files.length - FILES_SHOWN === 1 ? 'file' : 'files'}`}
            </button>
          )}
        </div>
      )}
      {finished && (
        <div className="chat-under">
          {verdict && (verdict.reviewable
            ? <button type="button" className={`delivery-output-badge tc-verdict tone-${verdict.tone}`} title={verdict.detail} aria-haspopup="dialog" onClick={() => setReviewing(true)}>{VERDICT_ICON[verdict.tone]}{verdict.label}</button>
            : <span className={`delivery-output-badge tc-verdict tone-${verdict.tone}`} title={verdict.detail}>{VERDICT_ICON[verdict.tone]}{verdict.label}</span>)}
          <span className="tc-quiet">
            <button type="button" className="tc-link" onClick={copy}><Copy size={12} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
            <Share onSave={save} notion={notion} />
          </span>
          <NotionOutcome notion={notion} />
        </div>
      )}
      {reviewing && check && (
        <Review check={check} reviewed={reviewed} onClose={() => setReviewing(false)} onReviewed={() => { onReviewed(); setReviewing(false) }} onOpenFinding={(line) => { setReviewing(false); onOpenFinding(line) }} />
      )}
    </>
  )
}

/**
 * Saving and sending, behind one button: the answer as Markdown, and to Notion when it has not
 * gone there yet. Esc and a click elsewhere close it.
 */
function Share({ onSave, notion }: { onSave: () => void; notion: NotionSendState }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return (
    <span ref={box} className="tc-share" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) } }}>
      <button type="button" className="tc-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Share2 size={12} aria-hidden="true" />Share<ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <span className="tc-share-menu" role="group" aria-label="Share this answer">
          <button type="button" onClick={() => { onSave(); setOpen(false) }}><Download size={13} aria-hidden="true" />Download as Markdown</button>
          <NotionOffer notion={notion} onSent={() => setOpen(false)} />
        </span>
      )}
    </span>
  )
}

/**
 * The review: what the record holds that is worth a look, each finding a click from its record, and
 * the acknowledgement that you checked it. It lasts while the chat stays open, as it always has.
 */
function Review({ check, reviewed, onClose, onReviewed, onOpenFinding }: { check: AnswerCheck; reviewed: boolean; onClose: () => void; onReviewed: () => void; onOpenFinding: (line: ReceiptLine) => void }) {
  const dialog = useModal()
  const [checked, setChecked] = useState(false)
  const { verdict } = check
  return (
    <dialog ref={dialog} className="delivery-review-dialog" aria-label="Review the answer" onCancel={onClose} onClose={onClose}>
      <h2>Review the answer</h2>
      {check.required > 0 && <p>{check.opened}/{check.required} required skills have loading evidence.</p>}
      {verdict.findings.length
        ? <section className="receipt-checks delivery-review-findings" aria-label="Worth a look"><b>Worth a look</b><ul>{verdict.findings.map((line, index) => <li key={index} className={`tone-${line.tone}`}><span>{line.text}</span>{(line.evidenceId || line.agentId) && <button type="button" className="receipt-open" aria-label={`Open: ${line.text}`} title={line.evidenceId ? 'Open the record' : 'Show this agent’s work'} onClick={() => onOpenFinding(line)}><ArrowRight size={12} aria-hidden="true" /></button>}</li>)}</ul></section>
        : <p>Nothing in this record was flagged.</p>}
      <p>Read the answer and its record before marking your review. It lasts while this chat stays open.</p>
      {reviewed ? <p className="delivery-review-success">Reviewed by you.</p> : <label><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />I have reviewed this answer and the evidence behind it.</label>}
      <div>
        <button type="button" className="btn" onClick={onClose}>Keep reading</button>
        {!reviewed && <button type="button" className="btn btn-primary" disabled={!checked || check.opened !== check.required} onClick={onReviewed}>Mark reviewed</button>}
      </div>
    </dialog>
  )
}

/** A dialog shown as a modal from the moment it mounts, so Esc and the backdrop work as expected. */
function useModal() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal?.()
  }, [])
  return dialog
}

/** Saves the answer as Markdown, named after its title and the day it was asked. */
function saveAnswer(answer: string, createdAt: string) {
  const url = URL.createObjectURL(new Blob([answer], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = answerFileName(answer, createdAt)
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
