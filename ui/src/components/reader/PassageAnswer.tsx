import { MessagesSquare, Reply, X } from '../ui/icon'
import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'

import { clockTime, dayLabel } from '../../lib/chat/format'
import { ToldWhy } from '../../lib/files/reader'
import { askedInChat, partLook, partQuote, yourWords, type AskedPassage, type PassageAnswer as Answer } from '../../lib/files/passage'
import { AvatarFace } from '../agents/AvatarFace'
import { InlineMarkdown, Markdown } from '../ui/Markdown'

interface PassageAnswerProps {
  passage: AskedPassage
  /** The same agent asked about the same words before, oldest first: the talk this answer goes on from. */
  earlier?: readonly AskedPassage[]
  name: (id: string) => string
  hue: (id: string) => number
  /** Where it sits on the reader's stage (`answerPlace`); `null` until it has been measured. */
  place: { top: number; left: number; above: boolean; arrow: number } | null
  /** The file no longer has the part (it was changed as asked): the answer sits at the top, pointing at nothing. */
  gone?: boolean
  /** The words it is about, when they are not the words it points at: a newer part overlaps them. */
  about?: string | null
  /** How tall its words may grow before they scroll. */
  maxHeight: number
  onClose: () => void
  /** Show what came of asking in the chat, where it is kept. */
  onShowInChat?: () => void
  /** Write back to the agent about the same part, in the message box; `button` is where the words fly from. */
  onReply?: (button: HTMLElement) => void
  /** A change not sent yet (ADR 0107): take it back; rejects with why it couldn't be. */
  onRemove?: () => Promise<void>
  /** A change made: write back the file as it was before its agent's turn. */
  onPutBack?: () => void
  /** How many changes that turn made, all of which Put back takes back. */
  putBackCount?: number
  ref?: Ref<HTMLElement>
}

const NO_TURNS: readonly AskedPassage[] = []

/**
 * What came of asking about a part of a file, beside the part (ADR 0077), as a reply to a comment
 * is: your words, then the agent's face and its answer, and Reply to go on. Asked again, the talk
 * about the part reads down from the first question. The chat keeps the same answers, under your
 * messages.
 */
export function PassageAnswer({ passage, earlier = NO_TURNS, name, hue, place, gone = false, about = null, maxHeight, onClose, onShowInChat, onReply, onRemove, onPutBack, putBackCount = 1, ref }: PassageAnswerProps) {
  const answer = passage.answer
  const by = 'by' in answer ? answer.by : passage.from
  const who = name(by)
  const asker = name(passage.from)
  const yours = yourWords(passage.asked, asker)
  const [removing, setRemoving] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null })
  const remove = () => {
    if (!onRemove || removing.busy) return
    setRemoving({ busy: true, problem: null })
    onRemove().catch((caught: unknown) => setRemoving({ busy: false, problem: caught instanceof ToldWhy ? caught.message : 'Couldn’t remove it. Try again.' }))
  }
  // The chat's own words for the same moments.
  const state = answer.state === 'said' ? when(answer.at)
    : answer.state === 'writing' ? 'is writing'
      : answer.state === 'working' ? 'is working'
        : answer.state === 'asking' ? 'asks you first'
        : answer.state === 'sending' ? 'Sending your question…'
          : answer.state === 'unsent' ? 'Not sent'
            : answer.state === 'failed' ? 'stopped'
              : answer.state === 'held' ? (answer.why === 'send' ? 'Waits for Send' : 'Waits its turn on this file') : ''
  const inChat = onShowInChat && askedInChat(passage)
  // With no answer to read, the way on is in the chat, said in words.
  const noAnswer = answer.state === 'failed' || answer.state === 'none' || answer.state === 'unsent' || answer.state === 'asking'
  const style: CSSProperties = place
    ? { top: place.top, left: place.left, '--rd-arrow': `${place.arrow}px` } as CSSProperties
    : { visibility: 'hidden', top: 0, left: 0 }
  // With talk before it, the newest question is brought into view, as a chat opens at its end.
  const body = useRef<HTMLDivElement>(null)
  const newest = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const scroller = body.current
    const asked = newest.current
    if (!scroller || !asked || earlier.length === 0) return
    scroller.scrollTop += asked.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 2
  }, [earlier.length, passage.messageId])
  return (
    <section ref={ref} className={`rd-answer ${partLook(answer, true)}${place?.above ? ' above' : ''}${gone ? ' gone' : ''}`} style={style} aria-label={passage.change ? `Your change for ${who}` : `${who}'s answer to your question`} data-reader-chrome>
      <header className="rd-answer-head">
        <AvatarFace id={by} hue={hue(by)} size={24} fontSize={9} text={initials(who)} className="rd-answer-face" />
        <b>{who}</b>
        {state && <span className="rd-answer-state">{state}</span>}
        <span className="rd-answer-acts">
          {inChat && !noAnswer && (
            <button type="button" onClick={onShowInChat} aria-label="Show it in the chat" title="Show it in the chat"><MessagesSquare size={14} aria-hidden="true" /></button>
          )}
          <button type="button" onClick={onClose} aria-label={passage.change ? 'Close' : 'Close the answer'} title="Close"><X size={14} aria-hidden="true" /></button>
        </span>
      </header>
      {about && <p className="rd-answer-about">About {partQuote(about)}</p>}
      {gone && <p className="rd-answer-gone">{passage.change ? `${who} changed these words.` : 'The words you marked have changed.'}</p>}
      <div ref={body} className="rd-answer-body" style={{ maxHeight }}>
        {earlier.map((turn, at) => (
          <div key={turn.messageId ?? at} className="rd-answer-turn">
            <Asked words={yourWords(turn.asked, name(turn.from))} change={Boolean(turn.change)} />
            <Said answer={turn.answer} who={name('by' in turn.answer ? turn.answer.by : turn.from)} />
          </div>
        ))}
        <Asked words={yours} ref={newest} change={Boolean(passage.change)} />
        <div role="status" aria-live="polite"><Said answer={answer} who={who} /></div>
        {noAnswer && inChat && <button type="button" className="rd-answer-chat" onClick={onShowInChat}>Show it in the chat</button>}
        {removing.problem && <p className="rd-answer-note" role="alert">{removing.problem}</p>}
      </div>
      {(onReply && answer.state === 'said') || onRemove || onPutBack ? (
        <footer className="rd-answer-foot">
          {onReply && answer.state === 'said' && <button type="button" className="rd-answer-reply" onClick={(event) => onReply(event.currentTarget)} aria-label={`Reply to ${who}`}><Reply size={12} aria-hidden="true" />Reply</button>}
          {onRemove && <button type="button" className="rd-answer-reply" onClick={remove} disabled={removing.busy} title="Take this change back">Remove</button>}
          {onPutBack && (
            <button type="button" className="rd-answer-reply" onClick={onPutBack} title={`Put the file back as it was before ${who}’s turn. Anything changed in it since goes too.`}>
              {putBackCount > 1 ? `Put back all ${putBackCount}` : 'Put back'}
            </button>
          )}
        </footer>
      ) : null}
    </section>
  )
}

/** Your words in the talk, as a comment's: quiet, over the answer they got. */
function Asked({ words, ref, change = false }: { words: string; ref?: Ref<HTMLParagraphElement>; change?: boolean }) {
  if (!words) return null
  // A change says so where it is read: on a done one, your words sit right over the agent's answer.
  return <p ref={ref} className="rd-answer-asked">{change ? <b className="rd-answer-asked-what">Your change: </b> : <span className="visually-hidden">You asked: </span>}<InlineMarkdown>{words}</InlineMarkdown></p>
}

/** What came back: the answer drawn as the chat draws it, the agent still at it, or why there is none. */
function Said({ answer, who }: { answer: Answer; who: string }) {
  if (answer.state === 'sending' || answer.state === 'writing' || answer.state === 'working') {
    const label = answer.state === 'sending' ? 'Sending your question' : `${who} ${answer.state === 'writing' ? 'is writing' : 'is working'}`
    return <span className="chat-dots" aria-label={label}><i /><i /><i /></span>
  }
  if (answer.state === 'said') return <div className="chat-text"><Markdown>{answer.text}</Markdown></div>
  if (answer.state === 'failed') return <p className="rd-answer-note">{answer.text}</p>
  if (answer.state === 'held') return null
  if (answer.state === 'asking') return <p className="rd-answer-note">{who} asks you something first. Answer it in the chat.</p>
  const nothing = answer.state === 'unsent' ? "Your question wasn't sent."
    : answer.state === 'none' ? { stopped: 'You stopped this.', note: 'Starts nothing · the team reads it next time', passed: `${who} had nothing to add.`, lost: 'No answer came back.' }[answer.why]
      : null
  return nothing ? <p className="rd-answer-note">{nothing}</p> : null
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
