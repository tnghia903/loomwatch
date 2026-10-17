import { daemonFetch } from '../daemonFetch'

/**
 * LoomWatch's own skills folder (backend `skills_store.rs`, `marketplace.rs`, `skills_api.rs`).
 *
 * LoomWatch keeps a copy of every skill its agents can use in `<state folder>/skills/<name>/`, and
 * records where each came from. Skills come in two ways, both only when the person asks:
 * - **Bring in from your apps** copies skills from the skill folders apps on this computer keep.
 *   It reads skill folders only, and copies what the person ticks.
 * - **Install** fetches from skills.sh, ClawHub or a GitHub link. The daemon does every fetch; this
 *   page never calls those sites itself. Inspect shows what a download holds before anything is
 *   installed.
 *
 * A skill whose license says "All rights reserved" is restricted and never comes in either way.
 */

/** How a skill reached the folder. `found`: someone put its folder there by hand. */
export type OriginKind = 'brought_in' | 'installed' | 'found'
export type SkillSource = 'github' | 'skills.sh' | 'clawhub'
export type SearchSource = Exclude<SkillSource, 'github'>
export type Runtime = 'node' | 'python'

export interface SkillOrigin {
  kind: OriginKind
  /** The app whose skill folder it was brought in from, e.g. `Claude Code`. */
  app?: string
  /** The folder it was copied from: on this computer, or inside the repository or download. */
  sourcePath?: string
  source?: SkillSource
  /** What was asked for: `owner/repo[/path][@ref]`, a skills.sh id, a ClawHub `owner/slug`. */
  ref?: string
  commit?: string
  /** A page about it the person can open. */
  url?: string
}

export interface SkillLicense {
  /** `MIT`, `Apache-2.0`, `All rights reserved`… Absent when the skill names none. */
  id?: string
  /** Its license says "All rights reserved" or "proprietary": it can never come in. */
  restricted: boolean
}

/** One skill in LoomWatch's folder: `GET /api/skills`. */
export interface SkillRecord {
  name: string
  description: string
  origin: SkillOrigin
  license: SkillLicense
  /** What its instructions assume, in the Library's words (`skill_routing::SkillNeed::label`). */
  needs: string[]
  runtimes: Runtime[]
  hasScripts: boolean
  sizeBytes: number
  /** Empty for a folder put there by hand. */
  sha256: string
  addedAt: string
  /** The bring-in it came with; Undo takes that bring-in back whole. */
  batchId?: string
}

export interface SkillsFolder {
  /** Where the folder is on this computer. */
  folder: string
  skills: SkillRecord[]
}

/** One skill an app on this computer has: `POST /api/skills/bring-in/preview`. */
export interface BringInCandidate {
  /** What `bringIn` takes. */
  key: string
  name: string
  description: string
  app: string
  /** The plugin it came with, when it came with one. */
  plugin?: string
  path: string
  license: SkillLicense
  restricted: boolean
  /** Why it can't be brought in (license, size, name), when it can't. */
  reason?: string
  needs: string[]
  runtimes: Runtime[]
  hasScripts: boolean
  sizeBytes: number
  fileCount: number
  alreadyInLoomWatch: boolean
  /** Ticked to start with: it can come in, isn't there yet, and no earlier app has one by its name. */
  defaultSelected: boolean
}

export interface SkippedSkill {
  name: string
  reason: string
}

/** `POST /api/skills/bring-in`. */
export interface BringInOutcome {
  batchId: string
  imported: SkillRecord[]
  skipped: SkippedSkill[]
}

/** One search hit: `GET /api/skills/search`. A ClawHub search can find skills.sh skills too. */
export interface SearchResult {
  source: SearchSource
  id: string
  name: string
  description?: string
  installs?: number
  url: string
  /** What `inspectInstall` takes, with `source`. */
  ref: string
  /** The publisher's picture, served by LoomWatch from its own copy (`/api/skills/avatar/…`). */
  avatar?: string
}

/** One skill folder in an inspected download. */
export interface InstallCandidate {
  /** Its folder inside the download; `.` when the download is the skill. What `installSkills` takes. */
  path: string
  name: string
  description: string
  license: SkillLicense
  restricted: boolean
  reason?: string
  /** Every file it holds; empty when it is too big to unpack. */
  files: string[]
  hasScripts: boolean
  runtimes: Runtime[]
  needs: string[]
  sizeBytes: number
  /** A skill with this name is already in LoomWatch: installing replaces it only when asked. */
  conflict: boolean
}

/** ClawHub's own safety check, when it has one. A skill it found harmful is never offered. */
export interface SafetyScan {
  status: 'clean' | 'suspicious' | 'pending' | 'error' | string
  hasWarnings: boolean
  url?: string
}

/** `POST /api/skills/install/inspect`: held by the daemon under `token` for 30 minutes. */
export interface Inspection {
  token: string
  source: SkillSource
  /** What was fetched, as the person would name it. */
  title: string
  url?: string
  commit?: string
  scan?: SafetyScan
  /** Things worth knowing that aren't about one skill: links left out, skills not shown. */
  notes: string[]
  candidates: InstallCandidate[]
}

/** The daemon's own words for what went wrong, and its status (409: the name is taken). */
export class SkillsApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** An older daemon has no skills routes yet: its page answers instead of the API. */
export const SKILLS_UNAVAILABLE = 'This LoomWatch can’t manage skills yet. Update LoomWatch, then open Skills again.'

const CHANGE = { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await daemonFetch(path, { cache: 'no-store', ...init })
  const html = response.headers?.get('content-type')?.includes('html') ?? false
  if (html) throw new SkillsApiError(SKILLS_UNAVAILABLE, response.status)
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || body === null) {
    throw new SkillsApiError(body?.error ?? (response.status === 404 ? SKILLS_UNAVAILABLE : 'Something went wrong. Try again.'), response.status)
  }
  return body
}

const change = <T>(path: string, method: string, body?: unknown) =>
  call<T>(path, { method, headers: CHANGE, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export const fetchSkills = () => call<SkillsFolder>('/api/skills')

/** Moves the skill to the folder's `.removed/`; answers its name. */
export const removeSkill = async (name: string) =>
  (await change<{ removed: string }>(`/api/skills/${encodeURIComponent(name)}`, 'DELETE')).removed

export const previewBringIn = async () =>
  (await change<{ candidates: BringInCandidate[] }>('/api/skills/bring-in/preview', 'POST')).candidates

export const bringIn = (keys: string[]) => change<BringInOutcome>('/api/skills/bring-in', 'POST', { keys })

/** Takes a bring-in back whole; answers the names it removed. */
export const undoBringIn = async (batchId: string) =>
  (await change<{ removed: string[] }>(`/api/skills/bring-in/${encodeURIComponent(batchId)}/undo`, 'POST')).removed

export const searchSkills = async (query: string, source: SearchSource) =>
  (await call<{ results: SearchResult[] }>(`/api/skills/search?${new URLSearchParams({ q: query, source })}`)).results

/** Without `source`, `ref` is a GitHub `owner/repo[/path][@ref]` or any GitHub, skills.sh or ClawHub link. */
export const inspectInstall = (ref: string, source?: SkillSource) =>
  change<Inspection>('/api/skills/install/inspect', 'POST', source ? { ref, source } : { ref })

/** Without `replace`, a name already in LoomWatch answers 409 and nothing is installed. */
export const installSkills = async (token: string, paths: string[], replace = false) =>
  (await change<{ installed: SkillRecord[] }>('/api/skills/install', 'POST', { token, paths, replace })).installed

// --- Words for the page -------------------------------------------------------------------------

export const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : 'Something went wrong. Try again.')

/** `1 skill`, `3 skills`. */
export const skillCount = (count: number): string => `${count} skill${count === 1 ? '' : 's'}`

export const RUNTIME_LABEL: Record<Runtime, { label: string; hint: string }> = {
  node: { label: 'Needs Node', hint: 'It comes with scripts that run with Node.js, which this computer needs to have.' },
  python: { label: 'Needs Python', hint: 'It comes with scripts that run with Python, which this computer needs to have.' },
}

/** `skill_routing::SkillNeed::label` → what it means for the person. */
const NEED_LABEL: Record<string, string> = {
  subagents: 'Uses helper agents',
  scripts: 'Runs scripts',
  'slash commands': 'Uses slash commands',
  'named tools': 'Names specific tools',
  'Claude surfaces': 'Written for another app',
  'other skills': 'Uses other skills',
}

export const needLabel = (need: string): string => NEED_LABEL[need] ?? need

const SOURCE_NAME: Record<SkillSource, string> = { github: 'GitHub', 'skills.sh': 'skills.sh', clawhub: 'ClawHub' }

export const sourceName = (source: SkillSource): string => SOURCE_NAME[source] ?? source

/** Where a skill came from, in a few words. */
export function describeOrigin(origin: SkillOrigin): string {
  switch (origin.kind) {
    case 'brought_in': return origin.app ? `Brought in from ${origin.app}` : 'Brought in from your apps'
    case 'installed': return origin.source ? `Installed from ${sourceName(origin.source)}` : 'Installed'
    default: return 'Added to the folder by hand'
  }
}

export function licenseLabel(license: SkillLicense): string {
  if (license.restricted) return license.id ? `${license.id} (can’t be copied)` : 'All rights reserved (can’t be copied)'
  return license.id ? `License: ${license.id}` : 'No license given'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** ClawHub's safety check, said plainly. */
export function scanLabel(scan: SafetyScan): string {
  const status = {
    clean: scan.hasWarnings ? 'passed, with warnings' : 'passed',
    suspicious: 'found something suspicious',
    pending: 'hasn’t finished yet',
    error: 'couldn’t finish',
  }[scan.status] ?? scan.status
  return `ClawHub’s safety check ${status}.`
}

/** `/Users/me/.claude/skills/pdf` → `~/.claude/skills/pdf`, which reads the same on every Mac. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~')
}

// --- Finding skills -----------------------------------------------------------------------------

/** What a skill is about, as far as its name and description tell: each has its own icon. */
export type SkillTopic =
  | 'pdf' | 'doc' | 'sheet' | 'slides' | 'meeting' | 'email' | 'research' | 'data' | 'marketing' | 'design' | 'image'
  | 'video' | 'audio' | 'translate' | 'calendar' | 'finance' | 'legal' | 'security' | 'database' | 'test' | 'code' | 'web' | 'writing'

/** First match wins, so the more particular topics come first: `pdf-to-docx` is about PDFs. */
const TOPIC_WORDS: [SkillTopic, RegExp][] = [
  ['pdf', /\bpdf/],
  ['sheet', /\b(spreadsheets?|excel|xlsx|csv|formulas?|google sheets)\b/],
  ['slides', /\b(slides?|slideshows?|presentations?|pptx|powerpoint|keynote|decks?)\b/],
  ['doc', /\b(docx|word documents?|documents?|docs)\b/],
  ['meeting', /\b(meetings?|minutes|transcripts?|standups?)\b/],
  ['email', /\b(e-?mails?|inbox|newsletters?|gmail)\b/],
  ['marketing', /\b(marketing|seo|campaigns?|ads|advertis\w*|social media|growth|copywriting|landing pages?)\b/],
  ['research', /\b(research\w*|investigat\w*|literature|citations?|fact[- ]check\w*)\b/],
  ['data', /\b(data|analy[sz]\w*|charts?|dashboards?|metrics|statistic\w*|kpis?|reports?)\b/],
  ['design', /\b(design\w*|brand\w*|ui|ux|figma|colou?rs?|typography|logos?|frontend|css|tailwind)\b/],
  ['image', /\b(images?|photos?|pictures?|illustrations?|icons?|svg|png|drawings?)\b/],
  ['video', /\b(videos?|films?|animations?|youtube|clips?)\b/],
  ['audio', /\b(audio|music|podcasts?|voice|speech|sound)\b/],
  ['translate', /\b(translat\w*|languages?|locali[sz]\w*)\b/],
  ['calendar', /\b(calendars?|schedul\w*|appointments?|events?)\b/],
  ['finance', /\b(financ\w*|invoices?|accounting|budgets?|tax(es)?|expenses?|payments?)\b/],
  ['legal', /\b(legal|contracts?|compliance|polic(y|ies)|gdpr)\b/],
  ['security', /\b(security|secure|vulnerab\w*|threats?|privacy|secrets?)\b/],
  ['database', /\b(databases?|sql|postgres\w*|mysql|sqlite|queries)\b/],
  ['test', /\b(tests?|testing|qa|e2e)\b/],
  ['code', /\b(code|coding|programm\w*|git|github|refactor\w*|debug\w*|review\w*|typescript|python|react)\b/],
  ['web', /\b(web|websites?|browser|scrap\w*|crawl\w*|html|urls?)\b/],
  ['writing', /\b(writ\w*|essays?|blogs?|articles?|copy|edit\w*|proofread\w*|style|grammar|notes)\b/],
]

/** What a skill is about: its name decides first, then its description. */
export function topicOf(name: string, description = ''): SkillTopic | null {
  const words = (text: string) => text.toLowerCase().replace(/[-_]+/g, ' ')
  for (const text of [words(name), words(description)]) {
    const hit = TOPIC_WORDS.find(([, pattern]) => pattern.test(text))
    if (hit) return hit[0]
  }
  return null
}

/** Topics a newcomer can start from, each a search both sites answer well (checked 2026-10-17). */
export const SKILL_TOPICS: { label: string; query: string; topic: SkillTopic }[] = [
  { label: 'PDFs and forms', query: 'pdf', topic: 'pdf' },
  { label: 'Spreadsheets', query: 'spreadsheet', topic: 'sheet' },
  { label: 'Presentations', query: 'presentation', topic: 'slides' },
  { label: 'Research', query: 'research', topic: 'research' },
  { label: 'Writing', query: 'writing', topic: 'writing' },
  { label: 'Design', query: 'design', topic: 'design' },
  { label: 'Marketing', query: 'marketing', topic: 'marketing' },
  { label: 'Data analysis', query: 'data analysis', topic: 'data' },
  { label: 'Meeting notes', query: 'meeting', topic: 'meeting' },
]

/**
 * Whether the search box holds a link rather than words: a github.com, skills.sh or clawhub.ai
 * address, or GitHub's own `owner/repo[/path][@ref]` shorthand (no spaces, at least one `/`).
 */
export function looksLikeLink(text: string): boolean {
  const value = text.trim()
  if (/^(https?:\/\/)?(www\.)?(github\.com|skills\.sh|clawhub\.ai)\//i.test(value)) return true
  return /^[\w.-]+\/[\w.-]+(\/[\w./-]*)?(@[\w./-]+)?$/.test(value) && !value.startsWith('.')
}

/** The two sites' answers as one list: each in its own order of relevance, taking turns, without repeats. */
export function mergeResults(lists: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>()
  const merged: SearchResult[] = []
  const longest = Math.max(0, ...lists.map((list) => list.length))
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const result = list[index]
      if (!result) continue
      const key = `${result.source}:${result.ref.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(result)
    }
  }
  return merged
}

export interface FoundSkills {
  results: SearchResult[]
  /** Sites that didn't answer; the other one's results are still shown. */
  missed: SearchSource[]
}

/** Search skills.sh and ClawHub at once. Fails only when neither answers. */
export async function searchEverywhere(query: string): Promise<FoundSkills> {
  const sources: SearchSource[] = ['skills.sh', 'clawhub']
  const answers = await Promise.allSettled(sources.map((source) => searchSkills(query, source)))
  const lists: SearchResult[][] = []
  const missed: SearchSource[] = []
  answers.forEach((answer, index) => {
    if (answer.status === 'fulfilled') lists.push(answer.value)
    else missed.push(sources[index])
  })
  if (lists.length === 0) {
    const first = answers[0]
    throw first.status === 'rejected' ? first.reason : new Error('Search didn’t answer. Try again.')
  }
  return { results: mergeResults(lists), missed }
}

/**
 * The search results already in your folder: those installed from the same site and reference.
 * A name alone isn't enough, since many different skills are called `pdf`.
 */
export const installedKeys = (skills: SkillRecord[]): Set<string> =>
  new Set(skills.flatMap((skill) => (skill.origin.source && skill.origin.ref ? [`${skill.origin.source}:${skill.origin.ref.toLowerCase()}`] : [])))

/** The key one search result is known by on the page. */
export const resultKey = (result: Pick<SearchResult, 'source' | 'ref'>): string => `${result.source}:${result.ref.toLowerCase()}`

/** The skill a reference names: `anthropics/skills/pdf` and `awspace/pdf` are both `pdf`. */
export const skillNameOf = (ref: string): string => ref.split('/').filter(Boolean).pop() ?? ref

/** Who published it: the first part of its reference. */
export const ownerOf = (ref: string): string => ref.split('/')[0] ?? ''

/** Who published a search result, with their picture when the daemon has one. */
export interface Publisher {
  name: string
  avatar?: string
}

export const publisherOf = (result: Pick<SearchResult, 'ref' | 'avatar'>): Publisher => ({ name: ownerOf(result.ref), avatar: result.avatar })

const UPPER = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'api', 'ai', 'ui', 'ux', 'seo', 'sql', 'html', 'css', 'json', 'yaml', 'mcp', 'llm', 'aws', 'gcp', 'url', 'ocr', 'svg', 'png', 'gif', 'ios', 'crm', 'cli', 'faq', 'kpi', 'okr'])

/** `remove-pdf-watermark` → `Remove PDF watermark`: a folder name read as words. */
export function displayName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return name
  return words.map((word, index) => {
    const lower = word.toLowerCase()
    if (UPPER.has(lower)) return lower.toUpperCase()
    if (index === 0 && word === lower) return lower.charAt(0).toUpperCase() + lower.slice(1)
    return word
  }).join(' ')
}

/** `212k`, `1.4M`: a count read at a glance. */
export function compactCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${count < 10_000 ? (count / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

const GLYPH_COLORS = ['clay', 'butter', 'sage', 'sky', 'lilac', 'rose', 'oat'] as const

/** One of the figure colours, the same for a name every time. */
export function glyphColor(name: string): string {
  let hash = 0
  for (const character of name.toLowerCase()) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `var(--color-fig-${GLYPH_COLORS[hash % GLYPH_COLORS.length]})`
}

/** Where a skill came from, as short as the shelf has room for. */
export function originShort(origin: SkillOrigin): string {
  switch (origin.kind) {
    case 'brought_in': return origin.app ?? 'Your apps'
    case 'installed': return origin.source ? sourceName(origin.source) : 'Installed'
    default: return 'Added by hand'
  }
}

// --- What to know before adding -------------------------------------------------------------------

export interface Notice {
  /** `ok`: nothing to worry about. `note`: worth reading. `stop`: it can't be added. */
  tone: 'ok' | 'note' | 'stop'
  text: string
}

const OPEN_LICENSES = /^(MIT|Apache-2\.0|BSD|ISC|MPL-2\.0|GPL|LGPL|AGPL|Unlicense|Creative Commons|BSL-1\.0|CC0|CC-BY)/i
const RUNTIME_NAME: Record<Runtime, string> = { node: 'Node.js', python: 'Python' }

/** ClawHub's safety check as a notice. */
export function scanNotice(scan: SafetyScan): Notice {
  if (scan.status === 'clean' && !scan.hasWarnings) return { tone: 'ok', text: 'ClawHub’s safety check passed.' }
  if (scan.status === 'suspicious') return { tone: 'note', text: 'ClawHub’s safety check found something suspicious. Add it only if you trust who made it.' }
  return { tone: 'note', text: `${scanLabel(scan)} You can read the details on its page.` }
}

/** What someone should know before adding this skill, most important first, in plain words. */
export function noticesFor(candidate: InstallCandidate | BringInCandidate, scan?: SafetyScan): Notice[] {
  // A skill that can't be added needs only the reason; the rest would be noise.
  if (candidate.reason) return [{ tone: 'stop', text: candidate.reason }]
  const notices: Notice[] = []
  if (scan) notices.push(scanNotice(scan))
  if ('conflict' in candidate && candidate.conflict) {
    notices.push({ tone: 'note', text: `You already have a skill called “${candidate.name}”. Adding this one replaces it, and LoomWatch keeps your current copy in its removed folder.` })
  }
  if (!candidate.license.restricted) {
    const id = candidate.license.id
    if (id && OPEN_LICENSES.test(id)) notices.push({ tone: 'ok', text: `Open license (${id}): free to use.` })
    else if (id) notices.push({ tone: 'note', text: `License: ${id}. Read it on its page if you’re not sure it covers your use.` })
    else notices.push({ tone: 'note', text: 'It names no license. Check its page before you use it for work.' })
  }
  if (candidate.hasScripts) {
    const needs = candidate.runtimes.map((runtime) => RUNTIME_NAME[runtime]).join(' and ')
    notices.push({ tone: 'note', text: needs
      ? `Comes with scripts. Nothing runs now: your agents run them only when a task needs them, and this computer needs ${needs} for that.`
      : 'Comes with scripts. Nothing runs now: your agents run them only when a task needs them.' })
  } else {
    notices.push({ tone: 'ok', text: 'Instructions only: no scripts.' })
  }
  return notices
}
