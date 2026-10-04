/**
 * Files an agent mentions in its reply, recognised so the UI can show a file — something to open —
 * instead of a raw path (ADR 0026).
 *
 * Deliberately narrow: an absolute path whose last segment has an extension, written as inline
 * code, as a Markdown link, or as a `file://` URL — or a file name listed under such a folder
 * ([`withFolderPaths`]). Bare words and API routes ("/api/runs") are not files, and a false
 * positive would put an Open button on something that is not openable.
 */
const ABSOLUTE = /^(\/|[A-Za-z]:\\)/
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/

/** The path a code span or link names, if it names a file, else `null`. */
export function filePathFrom(text: string | null | undefined): string | null {
  if (!text) return null
  let value = text.trim()
  if (value.startsWith('file://')) {
    try { value = decodeURIComponent(new URL(value).pathname) } catch { return null }
  }
  if (!value || value.length > 1024 || /[\n\r]/.test(value)) return null
  if (!ABSOLUTE.test(value)) return null
  const name = baseName(value)
  if (!EXTENSION.test(name) || (name.startsWith('.') && name.split('.').length === 2)) return null
  return value
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function extensionOf(path: string): string {
  return EXTENSION.exec(baseName(path))?.[1]?.toLowerCase() ?? ''
}

const LABELS: Record<string, string> = {
  doc: 'Word document', docx: 'Word document', odt: 'Document', pages: 'Pages document', rtf: 'Rich text',
  xls: 'Spreadsheet', xlsx: 'Spreadsheet', ods: 'Spreadsheet', numbers: 'Numbers spreadsheet', csv: 'CSV table', tsv: 'Table',
  ppt: 'Slides', pptx: 'Slides', odp: 'Slides', key: 'Keynote slides',
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

/** Every distinct file a Markdown reply names, in the order it first names them. */
export function fileRefsIn(markdown: string): string[] {
  const text = withFolderPaths(markdown)
  const found: string[] = []
  const add = (candidate: string) => {
    const path = filePathFrom(candidate)
    if (path && !found.includes(path)) found.push(path)
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(match[1])
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) add(match[1])
  for (const match of text.matchAll(/(file:\/\/\/[^\s)>\]]+)/g)) add(match[1])
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
 */
export function withFolderPaths(markdown: string): string {
  const lines = markdown.split('\n')
  for (const passage of passagesOf(lines)) {
    const folders: Array<{ at: number; path: string }> = []
    passage.forEach((index, order) => {
      for (const match of lines[index].matchAll(MENTION)) {
        const path = folderPathFrom(match[1] ?? match[2] ?? match[3])
        if (path) folders.push({ at: order * LINE + (match.index ?? 0), path })
      }
    })
    if (!folders.length) continue
    // The nearest folder named before the name, else the first one named after it.
    const folderFor = (at: number) => folders.filter((folder) => folder.at < at).at(-1)?.path ?? folders.find((folder) => folder.at > at)?.path
    passage.forEach((index, order) => {
      lines[index] = lines[index].replace(MENTION, (whole: string, span?: string, href?: string, _url?: string, offset = 0) => {
        const relative = relativeFileFrom(span ?? href)
        const folder = relative ? folderFor(order * LINE + offset) : undefined
        if (!relative || !folder) return whole
        const path = joinPath(folder, relative)
        return span !== undefined ? `\`${path}\`` : `](${path})`
      })
    })
  }
  return lines.join('\n')
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
    try { value = decodeURIComponent(new URL(value).pathname) } catch { return null }
  }
  if (!value || value.length > 1024 || /[\n\r]/.test(value) || !ABSOLUTE.test(value)) return null
  const folder = value.replace(/[\\/]+$/, '')
  if (!folder || (folder === value && EXTENSION.test(baseName(folder)))) return null
  return folder
}

/** A file name, or a short path under a folder (`drafts/plan.pdf`), whose kind this module names. */
function relativeFileFrom(text: string | undefined): string | null {
  const value = text?.trim().replace(/^\.\//, '') ?? ''
  if (!value || value.length > 255 || ABSOLUTE.test(value) || value.includes('://')) return null
  if (/[\s`'"$|<>*?=;:()\\~]/.test(value)) return null
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) return null
  return Object.hasOwn(LABELS, extensionOf(value)) ? value : null
}

function joinPath(folder: string, relative: string): string {
  return folder.includes('\\') && !folder.includes('/') ? `${folder}\\${relative.replaceAll('/', '\\')}` : `${folder}/${relative}`
}
