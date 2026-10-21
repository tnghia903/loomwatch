import type { Evidence } from '../watch/events'

/**
 * What a call on the web was, read the same way by the receipt's counts (lib/story/reads.ts) and a
 * stage card's tray (lib/watch/cardActivity.ts), so the two never disagree on one screen.
 *
 * Claude's newer web tools write and run code at the provider to search and read. Runs recorded
 * before the daemon named those calls (2026-10-21) titled the code "Search the web: the web", and a
 * page read from inside that code "Read a page", with its address only in the result. So a page is
 * known by its input, its title, or what its result says it read; code is known by its new title or,
 * in an older record, its input.
 */
type Call = Pick<Evidence, 'name'> & Partial<Pick<Evidence, 'relation' | 'toolKind' | 'rawInput' | 'kind' | 'status' | 'content' | 'rawOutput'>>

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const field = (value: unknown, key: string) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined)
const firstLine = (name: string) => name.split('\n')[0].trim()

/** What a call said back: its content's text, else its raw output. */
export function outputText(item: Partial<Pick<Evidence, 'content' | 'rawOutput'>>): string {
  if (Array.isArray(item.content)) {
    const said = item.content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      const inner = record.content as Record<string, unknown> | undefined
      if (inner && typeof inner.text === 'string') return inner.text
      return typeof record.text === 'string' ? record.text : ''
    }).filter(Boolean).join('\n')
    if (said) return said
  }
  if (typeof item.rawOutput === 'string') return item.rawOutput
  if (item.rawOutput === null || item.rawOutput === undefined) return ''
  try { return JSON.stringify(item.rawOutput) } catch { return String(item.rawOutput) }
}

/** The page a call read: its input's address, its title's ("Read https://…"), or what its result says it read. */
export function webPageOf(item: Call): string | null {
  const given = text(field(item.rawInput, 'url'))
  if (given && /^https?:\/\//.test(given)) return given
  const titled = /^(?:read|fetch)\s+(https?:\/\/\S+)/i.exec(firstLine(item.name))?.[1]
  if (titled) return titled
  return /^Read (https?:\/\/\S+)/.exec(outputText(item).trim())?.[1] ?? null
}

/** Code the model ran at its provider for its web tools. */
export function isProviderCode(item: Call): boolean {
  if (item.relation === 'ran code') return true
  return item.toolKind === 'fetch' && typeof field(item.rawInput, 'code') === 'string'
}

/** A web search, however its app titled it. */
export function isWebSearch(item: Call): boolean {
  if (isProviderCode(item)) return false
  const title = firstLine(item.name).toLowerCase()
  if (title.startsWith('search the web') || title.startsWith('web search') || title.startsWith('search "')) return true
  return item.kind === 'search' && (field(item.rawInput, 'type') === 'webSearch' || /web_?search/i.test(item.name))
}

/** The words a web search was for, when its app kept them. */
export function searchWords(item: Call): string | null {
  const titled = /^search the web:\s*(.+)$/i.exec(firstLine(item.name))?.[1]?.trim()
  if (titled && titled !== 'the web') return titled
  return text(field(item.rawInput, 'query')) ?? /^search\s+["“](.+)["”]$/i.exec(firstLine(item.name))?.[1] ?? null
}

/** A page read that got nothing: it failed, or its provider said so in its result ("Failed: …"). */
export function failedRead(item: Call): boolean {
  return item.status === 'failed' || item.status === 'rejected' || /^Failed\b/.test(outputText(item).trim())
}
