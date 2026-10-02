/**
 * Files an agent mentions in its reply, recognised so the UI can show a file — something to open —
 * instead of a raw path (ADR 0026).
 *
 * Deliberately narrow: an absolute path whose last segment has an extension, written as inline
 * code, as a Markdown link, or as a `file://` URL. Bare words and API routes ("/api/runs") are not
 * files, and a false positive would put an Open button on something that is not openable.
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
  const found: string[] = []
  const add = (candidate: string) => {
    const path = filePathFrom(candidate)
    if (path && !found.includes(path)) found.push(path)
  }
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) add(match[1])
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) add(match[1])
  for (const match of markdown.matchAll(/(file:\/\/\/[^\s)>\]]+)/g)) add(match[1])
  return found
}
