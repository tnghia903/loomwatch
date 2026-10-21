import { useState, type ReactNode } from 'react'
import type { Found, FoundPassage, FoundPiece } from '../../lib/chat/client'
import { clockTime, dayLabel } from '../../lib/chat/format'
import { snippet } from '../../lib/chat/findWords'
import { FoundText } from './FoundText'

interface ChatFindProps {
  found: Found | null
  loading: boolean
  /** The search could not be read: said as that, never as nothing found. */
  failed: boolean
  /** Fewer letters than a search needs. */
  tooShort: boolean
  /** The most pieces the daemon gives: a full list says it holds the closest ones. */
  most: number
  /** An agent's name, and its face, as the chat draws them. */
  name: (id: string) => string
  face: (id: string) => ReactNode
  /** Open the chat at what was said, with the words lit; with no line, at the piece's start. */
  onOpen: (piece: FoundPiece, passage: FoundPassage | null) => void
  onRetry: () => void
}

/** Matching lines shown under a piece before Show more. */
const LINES_SHOWN = 3

/**
 * What a search of the chat found (ADR 0081), in place of the chat until it is closed: each piece of
 * work or team note that holds the words, best first, with the lines in it that do. The piece's own
 * first words open it at its start; a line opens the chat at that very message.
 */
export function ChatFind({ found, loading, failed, tooShort, most, name, face, onOpen, onRetry }: ChatFindProps) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const count = found?.pieces.length ?? 0
  const status = tooShort ? 'Type one more letter.'
    : failed ? 'Couldn’t search the chat just now.'
      : loading && !found ? 'Finding…'
        : count === 0 ? 'Nothing in this chat matches that.'
          : `${count >= most ? `The ${count} closest matches.` : count === 1 ? 'One piece of work matches.' : `${count} pieces of work match.`}${found?.everyWord ? '' : count === 1 ? ' It has only some of your words.' : ' Some have only some of your words.'}`
  return (
    <div className="tc-find" aria-busy={loading}>
      <p className="tc-find-count" role="status">
        {status}
        {failed && <button type="button" className="tc-link" onClick={onRetry}>Try again</button>}
      </p>
      {found && count > 0 && !failed && !tooShort && (
        <ol className="tc-find-pieces" aria-label="What matches">
          {found.pieces.map((piece) => {
            // The piece's first words are its title, so the line that is them isn't shown twice.
            const own = piece.kind === 'work' ? 'request' : `note:${piece.id}`
            const lines = piece.passages.filter((passage) => passage.target !== own)
            const shown = opened.has(piece.id) ? lines : lines.slice(0, LINES_SHOWN)
            const title = withoutMention(piece.title) || 'Your request'
            return (
              <li key={piece.id} className="tc-find-piece">
                <button type="button" className="tc-find-head" onClick={() => onOpen(piece, piece.passages.find((passage) => passage.target === own) ?? null)}
                  aria-label={`${title}, ${dayLabel(piece.at)}. Open this work in the chat`}>
                  <span className="tc-find-faces" aria-hidden="true">{piece.agents.map((id) => <span key={id}>{face(id)}</span>)}</span>
                  <span className="tc-find-title"><FoundText text={title} terms={found.terms} /></span>
                  <time dateTime={piece.at}>{dayLabel(piece.at)}</time>
                </button>
                {lines.length > 0 && (
                  <ul className="tc-find-lines">
                    {shown.map((passage) => (
                      <li key={`${passage.target}:${passage.part}:${passage.at}`}>
                        <button type="button" className="tc-find-line" onClick={() => onOpen(piece, passage)}
                          aria-label={`${passage.who ? name(passage.who) : 'You'}, ${clockTime(passage.at)}: ${snippet(passage.text, found.terms)}. Show it in the chat`}>
                          <span className="tc-find-who">{passage.who ? <>{face(passage.who)}<b>{name(passage.who)}</b></> : <b>You</b>}<time>{clockTime(passage.at)}</time></span>
                          <span className="tc-find-said"><FoundText text={snippet(passage.text, found.terms)} terms={found.terms} /></span>
                        </button>
                      </li>
                    ))}
                    {shown.length < lines.length && (
                      <li className="tc-find-more">
                        <button type="button" className="tc-link" onClick={() => setOpened((ids) => new Set(ids).add(piece.id))}>Show {lines.length - shown.length} more</button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** A request starts with the @ that routed it; the topic reads first without it. */
function withoutMention(text: string): string {
  return text.replace(/^@\S+\s+/, '')
}
