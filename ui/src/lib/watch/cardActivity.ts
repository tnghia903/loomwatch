import type { WorkPhase } from '../library/figure'
import { failedRead, isProviderCode, isWebSearch, outputText, searchWords, webPageOf } from '../story/webCalls'
import { commandName, commandOf } from '../story/commands'
import { skillName } from '../story/reads'
import { eventText, type Evidence, type RunEvent } from './events'
import { thoughtLine, workPhase } from './workPhase'

/**
 * What an agent's card on the Full trace shows of its work: what its figure acts out, the one thing
 * it is doing now by name, and a tray of everything it has used so far, one mark per kind. Its web
 * marks open the pages it read and what it searched. All of it comes from the run's own record, up
 * to the replay cursor, so a finished run can be scrubbed through as it happened.
 */
export type UseKind = 'skill' | 'web' | 'page' | 'code' | 'file' | 'write' | 'command' | 'plan' | 'ask' | 'tool'

/** The tray's order: what it was given first, then the web, then its own computer, then the team. */
export const USE_KINDS: readonly UseKind[] = ['skill', 'web', 'page', 'code', 'file', 'write', 'command', 'plan', 'ask', 'tool']

/** Each kind of mark in words, for its label and the top of its list. */
export const USE_NAMES: Readonly<Record<UseKind, string>> = {
  skill: 'Skills',
  web: 'Web searches',
  page: 'Web pages read',
  code: 'Programs it ran to search the web',
  file: 'Files read',
  write: 'Files changed',
  command: 'Commands',
  plan: 'Plan',
  ask: 'Teammates',
  tool: 'Tools',
}

/** The marks that open the web list. */
export const WEB_KINDS: ReadonlySet<UseKind> = new Set(['web', 'page', 'code'])

export interface Use {
  kind: UseKind
  /** The use by name: "Read arxiv.org/abs/1706.03762", "explain-like-im-5", "Run python3". */
  label: string
  /** The record it came from. */
  evidenceId: string
}

export interface TrayMark {
  kind: UseKind
  /** Every use of this kind so far, oldest first. */
  labels: string[]
}

export interface WebPage {
  url: string
  /** How many times it read this page. */
  times: number
  /** The team's answer links this exact page. */
  inAnswer: boolean
}

export interface WebSearch {
  /** The search words, when its provider said them. */
  query: string | null
  /** What it found, as its provider listed it: a title and the page's address. */
  found: { title: string; url: string }[]
}

export interface WebFinds {
  /** The pages it read, each once, grouped by site in the order it first reached each. */
  sites: { site: string; pages: WebPage[] }[]
  searches: WebSearch[]
  /** Page reads that got it nothing. */
  failedReads: number
  /** Times the model ran code at its provider to search and read. */
  code: number
}

export interface CardActivity {
  /** What its figure acts out, while it works; null when it isn't working. */
  phase: WorkPhase | null
  /** The start of its reasoning, while it thinks. */
  thought: string | null
  /** The call it is on now, by name, while it uses one. */
  doing: Use | null
  /** The end of what it has written so far, while it types. */
  said: string | null
  tray: TrayMark[]
  web: WebFinds
}

/** How much of what it is typing a card shows, at most: its last words. */
export const SAID_CHARS = 140

/** The end of the words it is writing now: its own messages since it was last handed something. */
function saidSoFar(events: readonly RunEvent[], agentId: string): string | null {
  const parts: string[] = []
  for (let index = events.length - 1; index >= 0 && parts.join('').length < SAID_CHARS * 4; index -= 1) {
    const event = events[index]
    if (event.agentId !== agentId) continue
    if (event.kind !== 'message') continue
    if (event.payload.role === 'user') break
    parts.unshift(eventText(event))
  }
  const said = parts.join('').replace(/[*#`_>|]/g, '').replace(/\s+/g, ' ').trim()
  if (!said) return null
  return said.length <= SAID_CHARS ? said : `…${said.slice(-SAID_CHARS).replace(/^\S*\s+/, '')}`
}

const ADDRESS = /https?:\/\/[^\s<>"'`)\]]+/g
const firstLine = (name: string) => name.split('\n')[0].trim()

const shortAddress = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** One record as a use on the card, or null for what isn't one (a permission answer, an opening prompt's skill). */
export function asUse(item: Evidence): Use | null {
  const make = (kind: UseKind, label: string): Use => ({ kind, label, evidenceId: item.id })
  if (item.kind === 'permission' || item.relation === 'loaded into prompt' || item.relation === 'directed') return null
  if (item.kind === 'skill') return make('skill', skillName(item) ?? firstLine(item.name))
  if (isProviderCode(item)) return make('code', 'Search and read the web')
  if (isWebSearch(item)) {
    const query = searchWords(item)
    return make('web', query ? `Search the web: ${query}` : 'Search the web')
  }
  if (item.kind === 'source') {
    const page = webPageOf(item)
    if (page) return make('page', `Read ${shortAddress(page)}`)
    // A page read with no address in its record, which got nothing back.
    if (item.toolKind === 'fetch') return make('page', failedRead(item) ? 'Couldn’t read a page' : 'Read a page')
    // A notebook entry, or another source that isn't a web page.
    return make('tool', item.relation === 'retrieved' ? `Read note ${firstLine(item.name)}` : firstLine(item.name))
  }
  if (item.kind === 'file') {
    const path = item.locations[0]?.path ?? firstLine(item.name).replace(/^\w+\s+/, '')
    // A folder it listed says so: "Look in writer", not "Read writer".
    const verb = /^list\b/i.test(firstLine(item.name)) ? 'Look in' : 'Read'
    return item.relation === 'read file' ? make('file', `${verb} ${baseName(path)}`) : make('write', `${item.relation === 'deleted file' ? 'Delete' : 'Change'} ${baseName(path)}`)
  }
  if (item.kind === 'command') return make('command', `Run ${commandName(commandOf(item)) ?? firstLine(item.name)}`)
  if (item.kind === 'plan') return make('plan', 'Update the plan')
  if (item.kind === 'delegation') return make('ask', item.target ? `${item.relation[0].toUpperCase()}${item.relation.slice(1)} ${item.target}` : firstLine(item.name))
  if (item.kind === 'search') return make('file', `Find ${firstLine(item.name)}`)
  return make('tool', firstLine(item.name))
}

/** An address as two answers' links compare: no scheme, no www, no trailing slash or #part. */
const sameAddress = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/#.*$/, '').replace(/[/.,;:]+$/, '').toLowerCase()

/** The addresses an answer links, compared as `sameAddress` does. */
export function linkedIn(reply: string): Set<string> {
  return new Set([...reply.matchAll(ADDRESS)].map((match) => sameAddress(match[0])))
}

function found(item: Evidence): WebSearch['found'] {
  const lines = outputText(item).split('\n')
  const out: WebSearch['found'] = []
  for (const line of lines) {
    const match = /^(.*?)\s*(https?:\/\/\S+)\s*$/.exec(line.trim())
    if (match) out.push({ title: match[1].trim() || shortAddress(match[2]), url: match[2] })
  }
  return out
}

/** What one agent found on the web, from its records. `linked` is what the team's answer links. */
export function webFinds(evidence: readonly Evidence[], linked: ReadonlySet<string>): WebFinds {
  const sites = new Map<string, Map<string, WebPage>>()
  const searches: WebSearch[] = []
  let failedReads = 0
  let code = 0
  for (const item of evidence) {
    const use = asUse(item)
    if (!use) continue
    if (use.kind === 'code') code += 1
    else if (use.kind === 'web') searches.push({ query: searchWords(item), found: found(item) })
    else if (use.kind === 'page') {
      const url = webPageOf(item)
      if (failedRead(item)) {
        failedReads += 1
        continue
      }
      if (!url) continue
      const site = (/^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url)?.[1] ?? url).toLowerCase()
      const pages = sites.get(site) ?? new Map<string, WebPage>()
      const page = pages.get(url) ?? { url, times: 0, inAnswer: linked.has(sameAddress(url)) }
      page.times += 1
      pages.set(url, page)
      sites.set(site, pages)
    }
  }
  return { sites: [...sites].map(([site, pages]) => ({ site, pages: [...pages.values()] })), searches, failedReads, code }
}

/** The tray: each kind it used, in `USE_KINDS` order, with every use of it. */
export function trayOf(evidence: readonly Evidence[]): TrayMark[] {
  const byKind = new Map<UseKind, string[]>()
  for (const item of evidence) {
    const use = asUse(item)
    if (use) byKind.set(use.kind, [...(byKind.get(use.kind) ?? []), use.label])
  }
  return USE_KINDS.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, labels: byKind.get(kind) ?? [] }))
}

export interface ActivityInput {
  /** The run's events up to the replay cursor. */
  events: readonly RunEvent[]
  /** This agent's records up to the replay cursor, in record order. */
  evidence: readonly Evidence[]
  agentId: string
  /** It is working at this moment of the run. */
  working: boolean
  /** The moment shown: now when following a live run, the cursor's own time when replaying. */
  now: number
  linked: ReadonlySet<string>
}

/** Its turn has ended and it has not been handed anything since: it waits, it doesn't work. */
function turnEnded(events: readonly RunEvent[], agentId: string): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.agentId !== agentId) continue
    if (event.kind === 'turn_end') return true
    if (event.kind === 'message' && event.payload.role === 'user') return false
  }
  return false
}

export function cardActivity({ events, evidence, agentId, working, now, linked }: ActivityInput): CardActivity {
  // A stage stays running until the run ends, so its own record says whether it is still at it.
  const phase = working && !turnEnded(events, agentId) ? workPhase(events, agentId, now) : null
  const thought = phase === 'thinking' ? thoughtLine(events, agentId) : null
  const lastCall = [...evidence].reverse().find((item) => item.callId !== null || item.kind === 'skill')
  const doing = phase === 'tools' && lastCall ? asUse(lastCall) : null
  const said = phase === 'typing' ? saidSoFar(events, agentId) : null
  return { phase, thought, doing, said, tray: trayOf(evidence), web: webFinds(evidence, linked) }
}
