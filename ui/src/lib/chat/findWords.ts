/**
 * Lighting the words a chat search found (ADR 0081), where they are shown.
 *
 * The daemon reads a search into words (`crates/loomwatch-backend/src/chat_find.rs`, `Term`) and
 * matches them on text it folds: lower case, accents taken off, `đ` read as `d`. This folds the same
 * way, one UTF-16 unit for one, so a match found in the folded text is a range in the shown text.
 * Both share test cases (`findWords.test.ts`, `chat_find::tests`).
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

/** One word of a search, as the daemon read it: a word matches when it equals `text`, or, with `prefix`, starts with it. */
export interface FindTerm {
  text: string
  prefix: boolean
}

const WORD = /[\p{L}\p{N}]/u

/** One UTF-16 unit as the search reads it. A half of a pair (an emoji) stays as it is. */
function foldUnit(unit: string): string {
  if (unit === 'đ' || unit === 'Đ') return 'd'
  const code = unit.charCodeAt(0)
  if (code >= 0xd800 && code <= 0xdfff) return unit
  const lower = unit.normalize('NFD')[0].toLowerCase()
  return lower.length === 1 ? lower : lower[0]
}

/** `text` as the search reads it, one unit for one. */
export function fold(text: string): string {
  let folded = ''
  for (let index = 0; index < text.length; index += 1) folded += foldUnit(text[index])
  return folded
}

/** Whether a folded word is one `term` finds. */
export function termFinds(term: FindTerm, word: string): boolean {
  return term.prefix ? word.startsWith(term.text) : word === term.text
}

/** Where `text` holds a word one of `terms` finds: `[start, end)` ranges, in order. */
export function matchesIn(text: string, terms: readonly FindTerm[]): Array<[number, number]> {
  if (!terms.length) return []
  const folded = fold(text)
  const found: Array<[number, number]> = []
  let start = -1
  for (let index = 0; index <= folded.length; index += 1) {
    const inWord = index < folded.length && WORD.test(folded[index])
    if (inWord && start < 0) start = index
    if (!inWord && start >= 0) {
      const word = folded.slice(start, index)
      if (terms.some((term) => termFinds(term, word))) found.push([start, index])
      start = -1
    }
  }
  return found
}

/** `text` in pieces, each found word its own piece, for showing with the words lit. */
export function segments(text: string, terms: readonly FindTerm[]): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = []
  let at = 0
  for (const [start, end] of matchesIn(text, terms)) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    at = end
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

/** Markdown read as the words it shows: no marks for bold, headings, code or links. */
export function plainWords(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * About `chars` characters of `markdown`'s words around the first one a term finds, cut at words,
 * with … where something was left out.
 */
export function snippet(markdown: string, terms: readonly FindTerm[], chars = 180): string {
  const text = plainWords(markdown)
  if (text.length <= chars) return text
  const first = matchesIn(text, terms)[0]?.[0] ?? 0
  let start = Math.max(0, first - Math.floor(chars / 3))
  if (start > 0) {
    const space = text.indexOf(' ', start)
    start = space >= 0 && space < first ? space + 1 : start
  }
  let end = Math.min(text.length, start + chars)
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    end = space > start ? space : end
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * The words of the search whose match the chat is showing (ADR 0081), lit wherever the chat or the
 * answer beside it shows text: plain text through `FoundText`, Markdown through its renderer. They
 * are lit with `<mark>` the app draws itself, the same in every browser: WebKit (seen 2026-10-21)
 * painted CSS Custom Highlight ranges on the wrong line, or not at all.
 */
let shownWords: readonly FindTerm[] | null = null
const listeners = new Set<() => void>()

/** Light these words in the chat and the answer beside it, or none. */
export function showFoundWords(terms: readonly FindTerm[] | null): void {
  shownWords = terms?.length ? terms : null
  for (const listener of listeners) listener()
}

/** Text inside here lights the found words: the chat's messages, and the answer read beside it. */
export const FindScopeContext = createContext(false)

/** The words to light here, or null outside the chat and the answer, or while nothing is shown. */
export function useFoundWords(): readonly FindTerm[] | null {
  const scoped = useContext(FindScopeContext)
  const words = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => shownWords,
    () => null,
  )
  return scoped ? words : null
}
