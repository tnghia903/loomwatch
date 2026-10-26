import { baseName, isAbsolutePath, isWindowsPath, pathFromFileUrl, splitPath } from './paths'

export { baseName }

/**
 * Files an agent mentions in its reply, recognised so the UI can show a file — something to open —
 * instead of a raw path (ADR 0026).
 *
 * Deliberately narrow: an absolute path whose last segment has an extension, written as inline
 * code, as a Markdown link, or as a `file://` URL — or a file name listed under such a folder, or a
 * file the run wrote named in plain words ([`withFolderPaths`]). Other bare words and API routes
 * ("/api/runs") are not files, and a false positive would put an Open button on something that is
 * not openable.
 */
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/

/** The path a code span or link names, if it names a file, else `null`. */
export function filePathFrom(text: string | null | undefined): string | null {
  if (!text) return null
  let value = text.trim()
  if (value.startsWith('file://')) {
    const path = pathFromFileUrl(value)
    if (path === null) return null
    value = path
  }
  if (!value || value.length > 1024 || /[\n\r]/.test(value)) return null
  if (!isAbsolutePath(value)) return null
  const name = baseName(value)
  if (!EXTENSION.test(name) || (name.startsWith('.') && name.split('.').length === 2)) return null
  return value
}

/**
 * The path a Markdown link points at, if it is a file. A link target cannot hold a space, so a
 * file with spaces in its name is written with `%20`s, which name the file only once undone.
 */
export function filePathFromLink(href: string | null | undefined): string | null {
  if (!href || href.trim().startsWith('file://')) return filePathFrom(href)
  try {
    return filePathFrom(decodeURIComponent(href))
  } catch {
    return filePathFrom(href)
  }
}

/**
 * Every file a run's agents read or wrote, by its full path: the paths their tool calls name. An
 * agent names a file in its reply as it sees it, from its own folder (`./guide.html`); these are
 * what such a name means.
 */
export function filesTouched(evidence: readonly { locations?: readonly { path: string }[] }[]): string[] {
  const found = new Set<string>()
  for (const item of evidence) {
    for (const { path } of item.locations ?? []) if (filePathFrom(path)) found.add(path)
  }
  return [...found]
}

/** The files a run's agents wrote or changed: what their edit calls name, of those that went through. */
export function filesWritten(evidence: readonly { toolKind?: string | null; status?: string; declined?: string; locations?: readonly { path: string }[] }[]): string[] {
  return filesTouched(evidence.filter((item) => item.toolKind === 'edit' && !item.declined && item.status !== 'failed' && item.status !== 'rejected'))
}

export function extensionOf(path: string): string {
  return EXTENSION.exec(baseName(path))?.[1]?.toLowerCase() ?? ''
}

const LABELS: Record<string, string> = {
  doc: 'Word document', docx: 'Word document', docm: 'Word document', odt: 'Document', pages: 'Pages document', rtf: 'Rich text',
  xls: 'Spreadsheet', xlsx: 'Spreadsheet', xlsm: 'Spreadsheet', ods: 'Spreadsheet', numbers: 'Numbers spreadsheet', csv: 'CSV table', tsv: 'Table',
  ppt: 'Slides', pptx: 'Slides', pptm: 'Slides', odp: 'Slides', key: 'Keynote slides',
  pdf: 'PDF',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image', svg: 'Image', heic: 'Image',
  mp3: 'Audio', wav: 'Audio', m4a: 'Audio', mp4: 'Video', mov: 'Video', webm: 'Video',
  md: 'Markdown', markdown: 'Markdown', txt: 'Text', log: 'Log',
  html: 'Web page', htm: 'Web page',
  json: 'JSON data', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  zip: 'Archive',
}

/** What a person would call this file ("Word document"), from its extension alone. */
export function fileLabel(path: string): string {
  const extension = extensionOf(path)
  return LABELS[extension] ?? (extension ? `${extension.toUpperCase()} file` : 'File')
}

/** The file's kind inside a sentence, after `article`: "a Word document", "a PDF", "an image", but "slides". */
export function fileKindIn(path: string, article: 'a' | 'the'): string {
  const label = fileLabel(path)
  // The names of apps, and kinds said by their letters, keep their capitals.
  const kind = /^(Word|Pages|Numbers|Keynote|[A-Z]{2,})\b/.test(label) ? label : label.toLowerCase()
  if (article === 'a' && /slides$/.test(kind)) return kind
  return `${article === 'a' && /^[aeiou]/i.test(kind) ? 'an' : article} ${kind}`
}

const NOUNS: Array<[RegExp, string]> = [
  [/^(docx?|odt|pages|rtf|md|markdown|txt)$/, 'document'],
  [/^(xlsx?|ods|numbers|csv|tsv)$/, 'spreadsheet'],
  [/^(pptx?|odp|key)$/, 'slides'],
  [/^pdf$/, 'PDF'],
  [/^(png|jpe?g|gif|webp|svg|heic)$/, 'image'],
  [/^(mp3|wav|m4a)$/, 'audio'],
  [/^(mp4|mov|webm)$/, 'video'],
  [/^html?$/, 'page'],
]

/** The word an Open button uses: "Open document", "Open slides" — "file" when nothing fits. */
export function fileNoun(path: string): string {
  const extension = extensionOf(path)
  return NOUNS.find(([pattern]) => pattern.test(extension))?.[1] ?? 'file'
}

/**
 * A file name read as a title: `market-research-report.docx` → "Market research report".
 * Names that already carry their own capitals ("Q3 Board Pack") keep them; only separators
 * become spaces.
 */
export function fileTitle(path: string): string {
  const stem = baseName(path).replace(EXTENSION, '')
  const words = stem.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return baseName(path)
  return words === words.toLowerCase() ? words[0].toUpperCase() + words.slice(1) : words
}

/** The agent whose managed workspace (`.loomwatch/<team>/<agent>/…`) holds a file, if it is one. */
export function workspaceAgent(folder: string | null | undefined): { team: string; agent: string } | null {
  const [root, team, agent] = (folder ?? '').split(/[\\/]/)
  return root === '.loomwatch' && team && agent ? { team, agent } : null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Where the file sits, in words: the team and agent for a managed workspace
 * (`.loomwatch/launch-plan/writer` → `launch-plan › writer`), else the folder path.
 */
export function folderWords(folder: string | null | undefined, path: string): string {
  const relative = folder ?? path.split(/[\\/]/).slice(-3, -1).join('/')
  return relative.replace(/^\.loomwatch[\\/]/, '').split(/[\\/]/).filter(Boolean).join(' › ')
}

/**
 * Every distinct file a Markdown reply names, in the order it first names them. `touched` is what
 * the run's agents read or wrote ([`filesTouched`]) and `agentFolder` the one the answering agent
 * works in, for the names they give from their own folder; `written` is what they wrote
 * ([`filesWritten`]), for the names they give in plain words.
 */
export function fileRefsIn(markdown: string, touched: readonly string[] = [], agentFolder: string | null = null, written: readonly string[] = []): string[] {
  const text = withFolderPaths(markdown, touched, agentFolder, written)
  const found: string[] = []
  const add = (path: string | null) => {
    if (path && !found.includes(path)) found.push(path)
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(filePathFrom(match[1]))
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) add(filePathFromLink(match[1]))
  for (const match of text.matchAll(/(file:\/\/\/[^\s)>\]]+)/g)) add(filePathFrom(match[1]))
  return found
}

/**
 * The reply with each bare file name it lists under a folder written out as that file's absolute
 * path, so the name is recognised as a file. Agents often say where once and then list names:
 *
 *     Files are in `/Users/me/teams/.loomwatch/plan/editor/outputs`:
 *     - `plan.docx`
 *     - `plan.pdf`
 *
 * Still narrow (ADR 0026): a name resolves only against an absolute folder named in the same
 * passage — one paragraph and the list that carries on after it — and only when its extension is a
 * kind of file this module can name. Commands, domains, versions, names in another paragraph and
 * anything in a fenced block stay text.
 *
 * An agent also names files from its own folder without saying where that is: "[Open the
 * guide](./guide.html)". Such a name, in a link or in code, resolves to the one file in `touched`
 * — what the run's agents read or wrote — whose path ends with it. A file it made with a command
 * was never touched by name, so a link to one resolves under `agentFolder`, where the answering
 * agent works. A name in code is not taken from there: code names files the agent ran or quoted too.
 *
 * Agents also name what they made in plain words, with no code or link at all:
 *
 *     Files are in /Users/me/project/design:
 *     - architecture.html
 *
 * Such a name, or its path, becomes a file only when it fits just one file in `written`, what the
 * run's agents wrote: those are real files, so a word is never taken for one it isn't.
 */
export function withFolderPaths(markdown: string, touched: readonly string[] = [], agentFolder: string | null = null, written: readonly string[] = []): string {
  const home = agentFolder && isAbsolutePath(agentFolder) ? agentFolder : null
  const lines = markdown.split('\n')
  const passages = passagesOf(lines)
  for (const passage of passages) {
    const folders: Array<{ at: number; path: string }> = []
    passage.forEach((index, order) => {
      for (const match of lines[index].matchAll(MENTION)) {
        const path = folderPathFrom(match[1] ?? match[2] ?? match[3])
        if (path) folders.push({ at: order * LINE + (match.index ?? 0), path })
      }
    })
    if (!folders.length && !touched.length && !home) continue
    // The nearest folder named before the name, else the first one named after it.
    const folderFor = (at: number) => folders.filter((folder) => folder.at < at).at(-1)?.path ?? folders.find((folder) => folder.at > at)?.path
    passage.forEach((index, order) => {
      lines[index] = lines[index].replace(MENTION, (whole: string, span?: string, href?: string, _url?: string, offset = 0) => {
        if (span === undefined && href === undefined) return whole
        const named = span ?? decodedLink(href)
        const relative = relativeFileFrom(named)
        const folder = relative ? folderFor(order * LINE + offset) : undefined
        const path = relative && folder ? joinPath(folder, relative) : touchedFile(named, touched) ?? (href !== undefined ? fileUnder(home, named) : null)
        if (!path) return whole
        return span !== undefined ? `\`${path}\`` : `](${linkTarget(path)})`
      })
    })
  }
  const named = plainNames(written)
  if (named) for (const index of passages.flat()) lines[index] = named(lines[index])
  return lines.join('\n')
}

// What plain words may not be read inside: code, a link with its words, an HTML tag or a web address.
const KEPT = /`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g

/**
 * A line's plain words with each name of a file in `written` (`architecture.html`,
 * `design/architecture.html`, or its full path) as a code span of that file's full path, or `null`
 * when the run wrote nothing. A name stands alone: not inside another word, an address, code or a
 * link. A name two written files share stays words, unless given by its full path.
 */
function plainNames(written: readonly string[]): ((line: string) => string) | null {
  const files = written.filter((path) => !path.includes('`'))
  if (!files.length) return null
  const longestFirst = (a: string, b: string) => b.length - a.length
  const paths = [...files].sort(longestFirst).map(escapePattern).join('|')
  const names = [...new Set(files.map((path) => baseName(path)))].sort(longestFirst).map(escapePattern).join('|')
  // Before a name: the line's start, a space, or an opening bracket, quote or `*`. After it: the
  // line's end, a space, closing punctuation, or a full stop that ends the sentence. Its full path
  // first, which can hold spaces; else the name, with the folders before it.
  const name = new RegExp(`(^|[\\s(\\["'“‘*])(${paths}|(?:[^\\s\`'"()<>\\[\\]*]*[\\\\/])?(?:${names}))(?=$|[\\s)\\]"'”’*,;:!?]|\\.(?:\\s|$))`, 'g')
  const resolve = (words: string) => words.replace(name, (whole, before: string, said: string) => {
    const path = isAbsolutePath(said) ? files.find((file) => samePath(file, said)) : touchedFile(said, files)
    return path ? `${before}\`${path}\`` : whole
  })
  return (line) => {
    let out = ''
    let at = 0
    for (const match of line.matchAll(KEPT)) {
      out += resolve(line.slice(at, match.index)) + match[0]
      at = match.index + match[0].length
    }
    return out + resolve(line.slice(at))
  }
}

/** Whether two full paths name the same file, either separator, and on Windows in any case. */
function samePath(a: string, b: string): boolean {
  const fold = (part: string) => (isWindowsPath(a) ? part.toLowerCase() : part)
  const [left, right] = [splitPath(a), splitPath(b)]
  return left.length === right.length && left.every((part, index) => fold(part) === fold(right[index]))
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A code span, a link target, or a bare `file://` URL — in one pass, so offsets on a line agree.
const MENTION = /`([^`\n]+)`|\]\(([^)\s]+)\)|(file:\/\/\/[^\s)>\]`]+)/g
const LINE = 1_000_000
const FENCE = /^\s{0,3}(```|~~~)/
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/
const HEADING = /^\s{0,3}#{1,6}\s/

/**
 * The reply's lines grouped into passages: a blank line ends one unless a list carries on after it
 * (or the next line is indented under it), and a heading always starts one. Fenced blocks belong to
 * none.
 */
function passagesOf(lines: string[]): number[][] {
  const passages: number[][] = []
  let current: number[] = []
  let fenced = false
  let blank = false
  const close = () => {
    if (current.length) passages.push(current)
    current = []
  }
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      close()
      return
    }
    if (fenced) return
    if (!line.trim()) {
      blank = true
      return
    }
    if (HEADING.test(line) || (blank && !LIST_ITEM.test(line) && !/^\s{2,}\S/.test(line))) close()
    blank = false
    current.push(index)
  })
  close()
  return passages
}

/** The folder an absolute path names: no extension on its last segment, or a trailing separator. */
function folderPathFrom(text: string | undefined): string | null {
  let value = text?.trim() ?? ''
  if (value.startsWith('file://')) {
    const path = pathFromFileUrl(value)
    if (path === null) return null
    value = path
  }
  if (!value || value.length > 1024 || /[\n\r]/.test(value) || !isAbsolutePath(value)) return null
  const folder = value.replace(/[\\/]+$/, '')
  if (!folder || (folder === value && EXTENSION.test(baseName(folder)))) return null
  return folder
}

/** A file name, or a short path under a folder (`drafts/plan.pdf`), whose kind this module names. */
function relativeFileFrom(text: string | undefined): string | null {
  const value = text?.trim().replace(/^\.\//, '') ?? ''
  if (!value || value.length > 255 || isAbsolutePath(value) || value.includes('://')) return null
  if (/[\s`'"$|<>*?=;:()\\~]/.test(value)) return null
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) return null
  return Object.hasOwn(LABELS, extensionOf(value)) ? value : null
}

/** The one touched file whose path ends with `name` (`guide.html`, `./drafts/plan.md`), if just one. */
function touchedFile(name: string | undefined, touched: readonly string[]): string | null {
  const value = name?.trim() ?? ''
  if (!touched.length || !value || value.length > 255 || isAbsolutePath(value) || value.includes('://') || /[\n\r`]/.test(value)) return null
  const wanted = splitPath(value).filter((segment) => segment !== '.')
  if (!wanted.length || wanted.includes('..') || !EXTENSION.test(wanted[wanted.length - 1])) return null
  const found = touched.filter((path) => {
    const parts = splitPath(path)
    return parts.length > wanted.length && wanted.every((segment, index) => parts[parts.length - wanted.length + index] === segment)
  })
  return found.length === 1 ? found[0] : null
}

/**
 * A link's relative target (`./guide.html`, `drafts/plan.md`) as a file under `folder`, for a kind
 * of file this module names. Nothing that climbs out (`..`), hides (`.cache/…`), is a web address
 * or carries a query or a fragment.
 */
function fileUnder(folder: string | null, name: string | undefined): string | null {
  const value = name?.trim() ?? ''
  if (!folder || !value || value.length > 255 || isAbsolutePath(value) || /[\n\r`:?#*"<>|]/.test(value)) return null
  const segments = splitPath(value).filter((segment, index) => !(index === 0 && segment === '.'))
  if (!segments.length || segments.some((segment) => segment.startsWith('.') || segment !== segment.trim())) return null
  return Object.hasOwn(LABELS, extensionOf(value)) ? joinPath(folder, segments.join('/')) : null
}

function decodedLink(href: string | undefined): string | undefined {
  try {
    return href === undefined ? href : decodeURIComponent(href)
  } catch {
    return href
  }
}

/** A path as a Markdown link target, which ends at a space or a bracket: those as `%xx`. */
function linkTarget(path: string): string {
  return path.replace(/[\s()<>%]/g, (char) => encodeURIComponent(char))
}

function joinPath(folder: string, relative: string): string {
  return folder.includes('\\') && !folder.includes('/') ? `${folder}\\${relative.replaceAll('/', '\\')}` : `${folder}/${relative}`
}
