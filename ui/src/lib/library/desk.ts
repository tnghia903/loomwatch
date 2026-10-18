// Build by hand (components/agents/ByHand.tsx): what the desk's objects read from a draft.

import { checksBeforeReplying } from '../team-file/checkup'

/** The line of the instructions that says what it replies with, if any. A check it runs before replying is not that line. */
export function replyLine(role: string): string | null {
  const lines = role.split(/\n+|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean)
  const hit = lines.find((line) => !checksBeforeReplying(line) && /\b(reply|replies|respond|answer with|hand(s)? back|return|deliver)\b/i.test(line))
  if (!hit) return null
  return hit.length > 110 ? `${hit.slice(0, 107).trimEnd()}…` : hit
}

/** The words that say what it replies with, as `replyLine` finds them. */
const SAYS_REPLY = /\b(reply|replies|respond|answer with|hand(s)? back|return|deliver)\b/i

/** A sentence or line of `role`, and where it starts. */
interface Piece { text: string; at: number }

/** `role`'s paragraphs, each as its sentences and lines, with where each starts. */
function paragraphs(role: string): { at: number; end: number; pieces: Piece[] }[] {
  const out: { at: number; end: number; pieces: Piece[] }[] = []
  const blank = /\n[ \t]*\n\s*/g
  let from = 0
  for (const match of [...role.matchAll(blank), null]) {
    const end = match ? match.index : role.length
    const text = role.slice(from, end)
    const pieces: Piece[] = []
    for (const part of text.matchAll(/[^\n]+/g)) {
      // A line, cut after each sentence that ends in it.
      for (const sentence of part[0].matchAll(/[^.!?]+(?:[.!?]+|$)\s*/g)) {
        const lead = sentence[0].length - sentence[0].trimStart().length
        if (sentence[0].trim()) pieces.push({ text: sentence[0].trim(), at: from + part.index + sentence.index + lead })
      }
    }
    if (text.trim()) out.push({ at: from + text.length - text.trimStart().length, end: from + text.trimEnd().length, pieces })
    if (match) from = match.index + match[0].length
  }
  return out
}

/**
 * The part of the instructions that says what it hands back: from the sentence that says it to
 * the end of that paragraph, so a shape ("Reply in this shape:" and the headings under it) comes
 * whole. A paragraph that opens with it counts first, the last one first, since that is where the
 * hand-back goes; otherwise the first sentence that says it. A check it runs before replying is
 * not it. `start` is where it begins in `role`.
 */
export function replySection(role: string): { start: number; text: string } | null {
  const parts = paragraphs(role)
  const says = (piece: Piece | undefined) => Boolean(piece) && !checksBeforeReplying(piece!.text) && SAYS_REPLY.test(piece!.text)
  const opening = [...parts].reverse().find((part) => says(part.pieces[0]))
  if (opening) return { start: opening.at, text: role.slice(opening.at, opening.end) }
  for (const part of parts) {
    const hit = part.pieces.find(says)
    if (hit) return { start: hit.at, text: role.slice(hit.at, part.end) }
  }
  return null
}

/**
 * What it hands back, in a line: the shape's headings when it names them ("Replies in 4 parts:
 * Summary, Findings, …"), else the sentence that says it.
 */
export function replySays(section: string): string {
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean)
  const headings = lines.flatMap((line) => /^#{1,3}\s+(.+)$/.exec(line)?.[1].trim() ?? [])
  if (headings.length > 1) return `Replies in ${headings.length} parts: ${headings.join(', ')}`
  const first = lines[0] ?? ''
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}…` : first
}

/**
 * `role` with what it hands back written as `text`: in place of `section` when there is one, else
 * after the rest, as a paragraph of its own.
 */
export function withReply(role: string, section: { start: number; text: string } | null, text: string): { role: string; section: { start: number; text: string } } {
  if (section) return { role: `${role.slice(0, section.start)}${text}${role.slice(section.start + section.text.length)}`, section: { start: section.start, text } }
  const before = role.trimEnd()
  const lead = before ? `${before}\n\n` : ''
  return { role: `${lead}${text}`, section: { start: lead.length, text } }
}
