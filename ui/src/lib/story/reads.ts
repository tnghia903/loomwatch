import type { Evidence } from '../watch/events'

/**
 * What an agent's calls came to, judged by outcome rather than call by call.
 *
 * The record lists every call; the receipt and the answer's verdict report what came of them. The
 * two part ways when an agent tries one thing, it fails, and it gets there another way. Claude
 * Code, handed a linked knowledge folder (ADR 0042), often calls Read on the folder path itself,
 * gets `EISDIR`, then reads the files inside it: that call failed, but the folder was read. So a
 * failed read is a failure only when no read of the same thing succeeded — the same path or a path
 * inside it, the same page, the same skill. A folder none of whose files could be read still is.
 *
 * Counts are of things, not calls: a skill the agent opened and LoomWatch then recorded as opened
 * is one skill, and a file read in two pages is one file.
 */
type Item = Pick<Evidence, 'id' | 'kind' | 'relation' | 'name' | 'status' | 'toolKind' | 'rawInput' | 'locations'>

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const failed = (item: Pick<Evidence, 'status'>) => item.status === 'failed' || item.status === 'rejected'
const input = (item: Pick<Evidence, 'rawInput'>): Record<string, unknown> =>
  item.rawInput && typeof item.rawInput === 'object' ? (item.rawInput as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const clean = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')

/** A call that read something: a file, a skill's file, a page, a notebook entry. */
function isRead(item: Item): boolean {
  return item.relation === 'read file' || item.relation === 'consulted source' || item.relation === 'retrieved' || (item.kind === 'skill' && item.toolKind === 'read')
}

/** The paths a call named, from its locations and its input. */
function pathsOf(item: Item): string[] {
  const named = ['path', 'file_path', 'filePath'].map((key) => text(input(item)[key])).filter((path): path is string => path !== null)
  return [...new Set([...(item.locations ?? []).map((location) => location.path), ...named].map(clean).filter(Boolean))]
}

const pageOf = (item: Item) => text(input(item).url) ?? item.name
const noteOf = (item: Item) => text(input(item).id) ?? item.id

/**
 * The skill a skill call was about: the name LoomWatch recorded, the Skill tool's own input or
 * title ("Load skill: house-style", "Skill(house-style)"), or the folder its file sits in. `null`
 * when the call does not say.
 */
export function skillName(item: Pick<Evidence, 'name' | 'relation'> & Partial<Pick<Evidence, 'rawInput' | 'locations'>>): string | null {
  if (item.relation === 'opened by the agent' || item.relation === 'loaded into prompt') return item.name
  const title = item.name.split('\n')[0].trim()
  const tool = /^load skill:\s*(.+)$/i.exec(title)?.[1] ?? /^skill\((.+)\)$/i.exec(title)?.[1]
  if (tool) return tool.trim()
  if (/^(load skill|skill)$/i.test(title)) {
    const fields = input({ rawInput: item.rawInput })
    const named = ['skill', 'skill_name', 'skillName', 'command', 'name'].map((key) => text(fields[key])).find(Boolean)
    if (named) return named
  }
  for (const path of [title, ...(item.locations ?? []).map((location) => location.path)]) {
    const folder = path.match(/([^/\\\s'"]+)[/\\]SKILL\.md/i)?.[1] ?? path.match(/(?:^|[\s/\\'"])skills[/\\]([^/\\\s'"]+)[/\\]/i)?.[1]
    if (folder) return folder
  }
  return null
}

const skillKey = (item: Item) => (skillName(item) ?? item.name).toLowerCase()

/** A skill the agent opened or invoked. Supplied in its prompt is delivery, not use. */
const skillUse = (item: Item) => item.kind === 'skill' && item.status === 'succeeded' && item.relation !== 'loaded into prompt'

/** Whether something else the agent did got what this failed call was after. */
function madeUpFor(miss: Item, items: readonly Item[]): boolean {
  if (miss.kind === 'skill' && items.some((item) => skillUse(item) && skillKey(item) === skillKey(miss))) return true
  if (!isRead(miss)) return false
  const reads = items.filter((item) => item.status === 'succeeded' && isRead(item))
  if (miss.relation === 'consulted source') return reads.some((item) => item.relation === 'consulted source' && pageOf(item) === pageOf(miss))
  if (miss.relation === 'retrieved') return reads.some((item) => item.relation === 'retrieved' && noteOf(item) === noteOf(miss))
  const targets = pathsOf(miss)
  return reads.some((item) => pathsOf(item).some((path) => targets.some((target) => path === target || path.startsWith(`${target}/`))))
}

/**
 * One agent's failed calls that nothing else it did made up for, in record order. Refused
 * permission requests are left out: the receipt tells those apart by what was not allowed.
 */
export function failuresOf<T extends Item>(items: readonly T[]): T[] {
  return items.filter((item) => failed(item) && item.kind !== 'permission' && !madeUpFor(item, items))
}

/** The skills the agent used, each named once however many calls it took. */
export function skillsUsed(items: readonly Item[]): string[] {
  const used = new Map<string, string>()
  for (const item of items.filter(skillUse)) if (!used.has(skillKey(item))) used.set(skillKey(item), skillName(item) ?? item.name)
  return [...used.values()]
}

export interface ReadCount {
  files: number
  pages: number
  notes: number
}

/**
 * What was read successfully, each thing once: files by path, pages by address, notebook entries
 * by id. A skill's own files are counted as the skill, and the operator's answer and notebook
 * writes were not read by anyone.
 */
export function readCount(items: readonly Item[]): ReadCount {
  const files = new Set<string>()
  const pages = new Set<string>()
  const notes = new Set<string>()
  for (const item of items) {
    if (item.status !== 'succeeded') continue
    if (item.relation === 'read file' && item.kind === 'file') files.add(pathsOf(item)[0] ?? item.id)
    else if (item.relation === 'consulted source') pages.add(pageOf(item))
    else if (item.relation === 'retrieved') notes.add(noteOf(item))
  }
  return { files: files.size, pages: pages.size, notes: notes.size }
}

/** "3 files and 1 web page", or empty when nothing was read. */
export function readPhrase(count: ReadCount): string {
  const parts = [
    count.files && plural(count.files, 'file'),
    count.pages && plural(count.pages, 'web page'),
    count.notes && plural(count.notes, 'notebook entry', 'notebook entries'),
  ].filter((part): part is string => Boolean(part))
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? ''
}

/** Files changed successfully, each once: edited, deleted or moved. */
export function changedFiles(items: readonly Item[]): number {
  return new Set(items.filter((item) => item.kind === 'file' && item.relation !== 'read file' && item.status === 'succeeded').map((item) => pathsOf(item)[0] ?? item.id)).size
}
