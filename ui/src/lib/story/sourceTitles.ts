import { createContext } from 'react'

import type { Evidence } from '../watch/events'
import { isWebSearch, outputText } from './webCalls'

/**
 * The titles of the pages a run's web searches found, so a source its answer cites is named by its
 * page, not by its site (ADR 0116). Read from what the search gave the agent, as the daemon keeps
 * it, never by asking the page: a Claude model's search lists each page as `title url` on a line, a
 * ChatGPT plan's as its title, then its address, then a few words from it. A search that kept no
 * titles (OpenRouter's own) names nothing, and its sources say their site as before.
 *
 * The daemon reads them the same way for the phone (`crates/loomwatch-backend/src/devices/phone/
 * sources.rs`), with these tests' cases: change both.
 */
export function sourceTitles(evidence: readonly Pick<Evidence, 'name' | 'relation' | 'toolKind' | 'rawInput' | 'kind' | 'content' | 'rawOutput'>[]): Map<string, string> {
  const titles = new Map<string, string>()
  for (const item of evidence) {
    // A call recorded without its name is none of a search's; it never stops the answer drawing.
    if (typeof item.name !== 'string' || !isWebSearch(item)) continue
    const lines = outputText(item).split('\n').map((line) => line.trim())
    lines.forEach((line, at) => {
      const found = PAGE.exec(line)
      const key = found ? sourceKey(found[2]) : null
      if (!found || !key || titles.has(key)) return
      // On its own line, the address follows its title; the line before a search's first page says
      // what was searched for.
      const before = lines[at - 1] ?? ''
      const title = found[1] || (before && !PAGE.test(before) && !NOT_A_TITLE.test(before) ? before : '')
      if (title) titles.set(key, title)
    })
  }
  return titles
}

/** A page's address at the end of a line, after its title if it has one there. */
const PAGE = /^(.*?)\s*(https?:\/\/\S+)\s*$/
const NOT_A_TITLE = /^(Searched the web|Opened|Looked for|Nothing came back|It failed)\b/

/**
 * An address as a source is matched against what a search found: its site without `www.`, its path
 * without a closing slash, and its query; never its `#` part, which names a place on the page.
 */
export function sourceKey(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return null
  }
}

/** The titles of the pages the answer on screen came from, for its source chips (MarkdownRenderer). */
export const SourceTitlesContext = createContext<ReadonlyMap<string, string> | null>(null)
