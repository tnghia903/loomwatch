/**
 * A team's answer is either a message or a document (ADR 0051). A short reply reads as any chat
 * message does; a long one, or one with a title, is a document: the chat shows it as a card — its
 * title, its opening lines and its length — and it is read in full beside the chat. Everything here
 * is read from the agent's own text; nothing is summarised or guessed.
 */

/** Past this many characters an answer no longer reads as a chat message. */
export const DOCUMENT_CHARS = 600
/** A titled answer is a document from this length; "# Done" and a line is still a message. */
export const TITLED_CHARS = 280

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export function isDocument(answer: string): boolean {
  const text = answer.trim()
  return text.length > DOCUMENT_CHARS || (text.length > TITLED_CHARS && /^#{1,2}\s+\S/m.test(text))
}

export interface DocumentFacts {
  /** Its first heading, or its first line when it has none. */
  title: string
  /** Its opening words after the title, as plain text, cut at a word. */
  preview: string
  words: number
  /** Headings under the title; 0 when it has none. */
  sections: number
}

/** The title, opening lines and length of a document answer, from its own text. */
export function describeDocument(answer: string, previewChars = 220): DocumentFacts {
  const lines = answer.trim().split('\n')
  const titleAt = lines.findIndex((line) => HEADING.test(line))
  const firstText = lines.findIndex((line) => line.trim() !== '')
  const titled = titleAt >= 0 && titleAt <= firstText + 1
  const title = titled ? plain(lines[titleAt].match(HEADING)?.[2] ?? '') : cut(plain(lines[firstText] ?? ''), 80)
  const rest = lines.slice((titled ? titleAt : firstText) + 1)
  const prose = rest
    .filter((line) => !/^\s*(\|.*\||[-*_]{3,}|```)/.test(line))
    .map((line) => plain(line.replace(HEADING, '$2')))
    .filter(Boolean)
    .join(' ')
  const words = plain(answer).split(/\s+/).filter((word) => /\w/.test(word)).length
  const sections = rest.filter((line) => HEADING.test(line)).length
  return { title: title || 'The team’s answer', preview: cut(prose, previewChars), words, sections }
}

/** "1,240 words · 4 sections". */
export function documentSize({ words, sections }: Pick<DocumentFacts, 'words' | 'sections'>): string {
  const parts = [`${words.toLocaleString('en-US')} ${words === 1 ? 'word' : 'words'}`]
  if (sections > 1) parts.push(`${sections} sections`)
  return parts.join(' · ')
}

/** Markdown read as plain words: no markers, links as their text, code as its words. */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  const at = text.lastIndexOf(' ', limit)
  return `${text.slice(0, at > limit * 0.6 ? at : limit).replace(/[\s,;:.–—-]+$/, '')}…`
}
