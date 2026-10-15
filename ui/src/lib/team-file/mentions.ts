// Instructions that still name a source the team no longer gives (ADR 0059).
//
// Removing a card takes it out of the team file, but the instructions that name it stay, and an
// agent told to "find the EKIS page" goes on looking for it. These find whose instructions name a
// removed source, so the canvas can have them rewritten, and which sentences do, so the agent
// panel can point at them when they could not be.
//
// A match only picks whom to ask: the AI app decides what in the text depends on the source, and
// returns instructions that do not unchanged.

import { notionPageKey, type CapabilityNodeConfig } from '../composer-layout/types'
import { chosenIsFile } from '../knowledge/chosen'
import type { AgentConfig } from './types'

export interface RemovedSource {
  /** The card's id. If it is given again (an undo) before the rewrite arrives, the rewrite is dropped. */
  cardId: string
  /** Set when only the line from this agent to the card was removed; the card stays. */
  from?: string
  /** As the card showed it. */
  name: string
  /** What it was, in plain words, for the AI app and the panel: `Notion page`, `skill`, `folder`. */
  kind: string
  path?: string
  notionPage?: string
}

const KIND_WORDS: Record<string, string> = { skill: 'skill', tool: 'tool', knowledge: 'source' }

export function removedSource(card: Pick<CapabilityNodeConfig, 'id' | 'kind' | 'name' | 'path' | 'notion'>): RemovedSource {
  const kind = card.notion ? 'Notion page' : card.path ? (chosenIsFile(card.path) ? 'file' : 'folder') : KIND_WORDS[card.kind] ?? card.kind
  return {
    cardId: card.id, name: card.name, kind,
    ...(card.path ? { path: card.path } : {}),
    ...(card.notion ? { notionPage: card.notion.page } : {}),
  }
}

/** A term this short names too much to mean the source. */
const MIN_TERM = 3

interface Term {
  text: string
  /** A skill or tool name also matches with spaces for its dashes: "canvas design" is
      `canvas-design`. A folder's name does not: "the SUTD final project" is not `sutd-final-project`. */
  loose: boolean
}

/**
 * The words that name `source`: its name without a leading emoji, the short name before a dash
 * ("EKIS" in "EKIS — SUTD Final Project Hub"), and a path with its last part.
 */
function sourceTerms(source: RemovedSource): Term[] {
  const loose = source.kind === 'skill' || source.kind === 'tool'
  const name = source.name.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  const texts = [name]
  const short = name.split(/\s+[—–-]\s+|:\s+|\s+\|\s+/)[0]?.trim()
  if (short && short !== name) texts.push(short)
  if (source.path) texts.push(source.path, source.path.replace(/\/+$/, '').split('/').pop() ?? '')
  return [...new Set(texts)].filter((text) => text.length >= MIN_TERM).map((text) => ({ text, loose }))
}

/**
 * The terms that name `source` in `agent`'s instructions. A removed Notion page adds "Notion" itself
 * once the agent has no other Notion page: page cards are how LoomWatch gives an agent Notion
 * (ADR 0050), so "use the connected Notion tools" now points at nothing it was given.
 */
export function termsFor(agent: Pick<AgentConfig, 'capabilities'>, source: RemovedSource): Term[] {
  const terms = sourceTerms(source)
  const page = source.notionPage
  if (page !== undefined) {
    const another = (agent.capabilities ?? []).some((entry) => entry.notion && notionPageKey(entry.notion.page) !== notionPageKey(page))
    if (!another) terms.push({ text: 'Notion', loose: false })
  }
  return terms
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function pattern(term: Term): RegExp {
  const body = term.loose ? term.text.split(/[-_\s]+/).map(escape).join('[-_\\s]+') : escape(term.text)
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}

const naming = (text: string, terms: readonly Term[]) => terms.some((term) => pattern(term).test(text))

/** Whether `agent`'s instructions name `source`. */
export function namesSource(agent: Pick<AgentConfig, 'role' | 'capabilities'>, source: RemovedSource): boolean {
  return naming(agent.role ?? '', termsFor(agent, source))
}

/** The sentences of `role` that name `source`, in order, for the panel to quote. */
export function sentencesNaming(agent: Pick<AgentConfig, 'role' | 'capabilities'>, source: RemovedSource): string[] {
  const terms = termsFor(agent, source)
  return (agent.role ?? '').split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence && naming(sentence, terms))
}
