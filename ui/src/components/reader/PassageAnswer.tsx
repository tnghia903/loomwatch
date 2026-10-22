import { MessagesSquare, X } from 'lucide-react'
import type { CSSProperties, Ref } from 'react'

import { clockTime, dayLabel } from '../../lib/chat/format'
import { askedInChat, partLook, yourWords, type AskedPassage } from '../../lib/files/passage'
import { AvatarFace } from '../agents/AvatarFace'
import { Markdown } from '../ui/Markdown'

interface PassageAnswerProps {
  passage: AskedPassage
  name: (id: string) => string
  hue: (id: string) => number
  /** Where it sits on the reader's stage (`answerPlace`); `null` until it has been measured. */
  place: { top: number; left: number; above: boolean; arrow: number } | null
  /** The file no longer has the part (it was changed as asked): the answer sits at the top, pointing at nothing. */
  gone?: boolean
  /** How tall its words may grow before they scroll. */
  maxHeight: number
  onClose: () => void
  /** Show what came of asking in the chat, where it is kept. */
  onShowInChat?: () => void
  ref?: Ref<HTMLElement>
}

/**
 * What came of asking about a part of a file, beside the part (ADR 0077), as a reply to a comment
 * is: your words, then the agent's face and its answer. The chat keeps the same answer, under your
 * message.
 */
export function PassageAnswer({ passage, name, hue, place, gone = false, maxHeight, onClose, onShowInChat, ref }: PassageAnswerProps) {
  const answer = passage.answer
  const by = 'by' in answer ? answer.by : passage.from
  const who = name(by)
  const yours = yourWords(passage.asked, name(passage.from))
  // The chat's own words for the same moments.
  const state = answer.state === 'said' ? when(answer.at)
    : answer.state === 'writing' ? 'is writing'
      : answer.state === 'working' ? 'is working'
        : answer.state === 'sending' ? 'Sending your question…'
          : answer.state === 'unsent' ? 'Not sent'
            : answer.state === 'failed' ? 'stopped' : ''
  const inChat = onShowInChat && askedInChat(passage)
  // With no answer to read, the way on is in the chat, said in words.
  const noAnswer = answer.state === 'failed' || answer.state === 'none' || answer.state === 'unsent'
  const nothing = answer.state === 'unsent' ? "Your question wasn't sent."
    : answer.state === 'none' ? { stopped: 'You stopped this.', note: 'Starts nothing · the team reads it next time', passed: `${who} had nothing to add.`, lost: 'No answer came back.' }[answer.why]
      : null
  const style: CSSProperties = place
    ? { top: place.top, left: place.left, '--rd-arrow': `${place.arrow}px` } as CSSProperties
    : { visibility: 'hidden', top: 0, left: 0 }
  return (
    <section ref={ref} className={`rd-answer ${partLook(answer, true)}${place?.above ? ' above' : ''}${gone ? ' gone' : ''}`} style={style} aria-label={`${who}'s answer to your question`} data-reader-chrome>
      <header className="rd-answer-head">
        <AvatarFace id={by} hue={hue(by)} size={24} fontSize={9} text={initials(who)} className="rd-answer-face" />
        <b>{who}</b>
        {state && <span className="rd-answer-state">{state}</span>}
        <span className="rd-answer-acts">
          {inChat && !noAnswer && (
            <button type="button" onClick={onShowInChat} aria-label="Show it in the chat" title="Show it in the chat"><MessagesSquare size={14} aria-hidden="true" /></button>
          )}
          <button type="button" onClick={onClose} aria-label="Close the answer" title="Close"><X size={14} aria-hidden="true" /></button>
        </span>
      </header>
      {yours && <p className="rd-answer-asked"><span className="visually-hidden">You asked: </span>{yours}</p>}
      {gone && <p className="rd-answer-gone">The words you marked have changed.</p>}
      <div className="rd-answer-body" style={{ maxHeight }} role="status" aria-live="polite">
        {answer.state === 'said' ? <div className="chat-text"><Markdown>{answer.text}</Markdown></div>
          : answer.state === 'failed' ? <p className="rd-answer-note">{answer.text}</p>
            : nothing !== null ? <p className="rd-answer-note">{nothing}</p>
              : <span className="chat-dots" aria-label={answer.state === 'sending' ? 'Sending your question' : `${who} ${state}`}><i /><i /><i /></span>}
        {noAnswer && inChat && <button type="button" className="rd-answer-chat" onClick={onShowInChat}>Show it in the chat</button>}
      </div>
    </section>
  )
}

/** When it answered: the time today, and the day too before today. */
function when(at: string | null): string {
  if (!at) return ''
  const day = dayLabel(at)
  return !day || day === 'Today' ? clockTime(at) : `${day}, ${clockTime(at)}`
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}
