import { useState } from 'react'
import { CircleSlash, Undo2, X } from '../ui/icon'

import { checkerWords, triesShown, type DoneWhen } from '../../lib/chat/doneWhen'
import { setDoneWhen } from '../../lib/runs/client'
import { Appearing } from './Appearing'

/**
 * What the person's message said done looks like (ADR 0098), under the message: the items LoomWatch
 * read, quoted word for word, which the work is checked against before it becomes the answer.
 *
 * State first: the items, and "Up to N tries" when the message named a number. Each item has one
 * mark, while the check can still change, that stops it being checked from the next round on; a
 * dropped item stays, struck through, and the same mark brings it back. A read that failed says so
 * in one quiet line. A read that found nothing shows nothing.
 */
export function MessageDoneWhen({ runId, doneWhen, live, to }: { runId: string; doneWhen: DoneWhen; live: boolean; to: string }) {
  // What the daemon answered last, kept with the record it answered: a newer record replaces it.
  const [answered, setAnswered] = useState<{ to: DoneWhen; now: DoneWhen } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = answered?.to === doneWhen ? answered.now : doneWhen

  if (shown.state === 'failed') {
    return (
      <Appearing reveal className="tc-done-when failed">
        <CircleSlash size={14} aria-hidden="true" />
        <span>LoomWatch couldn’t read this message, so the work isn’t checked against it.</span>
      </Appearing>
    )
  }
  const open = live && !shown.ended
  const tries = triesShown(shown)
  const checker = checkerWords(shown)
  const checking = shown.items.some((item) => item.checked)
  const toggle = (index: number, checked: boolean) => {
    setError(null)
    setDoneWhen(runId, index, checked)
      .then((next) => { if (next) setAnswered({ to: doneWhen, now: next }) })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }
  return (
    <Appearing reveal className="tc-done-when" role="group" aria-label="Done when">
      <span className="tc-done-label" title={`Your message went to ${to} as you wrote it. LoomWatch only reads it, to check the work.${checker ? ` ${checker}` : ''}`}>Done when</span>
      <ul className="tc-done-items">
        {shown.items.map((item, index) => {
          const said = `“${item.text}”`
          return (
            <li key={`${index}:${item.text}`} className={item.checked ? undefined : 'off'}>
              <q>{item.text}</q>
              {!item.checked && <span className="visually-hidden"> (not checked)</span>}
              {open && (
                <button type="button" className="tc-done-mark" aria-label={item.checked ? `Don’t check ${said}` : `Check ${said}`} title={item.checked ? `Don’t check ${said}` : `Check ${said}`} onClick={() => toggle(index, !item.checked)}>
                  {item.checked ? <X size={12} aria-hidden="true" /> : <Undo2 size={12} aria-hidden="true" />}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {tries !== null && <span className="tc-done-tries">Up to {tries} {tries === 1 ? 'try' : 'tries'}</span>}
      {checking && <p className="tc-done-hint">{shown.ended ? 'The work was checked against these.' : 'The work is checked against these.'}</p>}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </Appearing>
  )
}
