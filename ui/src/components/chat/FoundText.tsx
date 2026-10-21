import { segments, useFoundWords, type FindTerm } from '../../lib/chat/findWords'

/**
 * Plain text with the words a search found lit (ADR 0081): `terms` when given, else the words of
 * the search the chat is showing a match of, else the text as it is.
 */
export function FoundText({ text, terms }: { text: string; terms?: readonly FindTerm[] }) {
  const shown = useFoundWords()
  const lit = terms ?? shown
  if (!lit?.length) return <>{text}</>
  return <>{segments(text, lit).map((part, index) => (part.hit ? <mark key={index} className="tc-find-hit">{part.text}</mark> : part.text))}</>
}
