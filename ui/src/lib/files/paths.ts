/**
 * Paths as the daemon sends them: `/Users/ana/LoomWatch/teams/…` on a Mac or Linux,
 * `C:\Users\ana\LoomWatch\teams\…` on Windows, where apps also print `C:/Users/…`. Every helper
 * here reads all of them, so nothing that names a file has to know which computer it is on.
 */

/** Whether `path` is a full path: `/…`, `C:\…`, `C:/…`, or a network share `\\server\…`. */
export function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

/** Whether `path` is written the Windows way: a drive or a network share, or only backslashes. */
export function isWindowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:|\\\\)/.test(path) || (path.includes('\\') && !path.includes('/'))
}

/** The names in a path, split on either separator, without empty ones. */
export function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

/** The last name in a path: `report.md` for `C:\…\report.md` or `/…/report.md`. */
export function baseName(path: string): string {
  return splitPath(path).at(-1) ?? path
}

/** The folder a path is in, without a trailing separator: `/` and `C:\` stay whole. */
export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '') || path
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return ''
  const folder = trimmed.slice(0, cut)
  if (folder === '' || /^[A-Za-z]:$/.test(folder)) return trimmed.slice(0, cut + 1)
  return folder
}

/** `relative`, a `/`-separated path, under the folder `root`, written with `root`'s own separator. */
export function joinUnderRoot(root: string, relative: string): string {
  const separator = isWindowsPath(root) ? '\\' : '/'
  return [root.replace(/[\\/]+$/, ''), ...splitPath(relative)].join(separator)
}

/**
 * `path` relative to the folder `root`, `/`-separated, as the daemon names files under it, or
 * `null` when it is not inside. Windows paths compare without regard to case, as Windows does.
 */
export function relativeUnder(root: string, path: string): string | null {
  const rootParts = splitPath(root)
  const parts = splitPath(path)
  if (parts.length <= rootParts.length) return null
  const same = isWindowsPath(root)
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b
  if (!rootParts.every((part, index) => same(part, parts[index]))) return null
  return parts.slice(rootParts.length).join('/')
}

/** Names Windows keeps for its devices. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * `stem`, the part of a file name before its ending, safe on every computer: Windows refuses a file
 * named `con`, `nul`, `com1` and the like, even as `con.yaml`, so those get `-1` after them.
 */
export function safeFileStem(stem: string): string {
  return RESERVED_NAMES.test(stem) ? `${stem}-1` : stem
}

/** The path a `file://` URL names: `C:\…` for `file:///C:/…`, `/…` otherwise. `null` if malformed. */
export function pathFromFileUrl(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll('/', '\\') : path
  } catch {
    return null
  }
}

/**
 * The file a link written in the file `from` names: `figures/chart.svg` or `../chart.png` beside
 * it, a full path, or a `file://` URL. `null` for anything else (the web, `data:`, a place in the
 * file) and for a link that steps above the top of the disk.
 */
export function linkedPath(from: string, link: string): string | null {
  const written = link.trim()
  if (/^file:/i.test(written)) return pathFromFileUrl(written)
  let value = written.replace(/[?#].*$/, '')
  try {
    value = decodeURIComponent(value)
  } catch {
    // Kept as written: a `%` that starts no escape is part of the name.
  }
  if (!value || value.startsWith('//')) return null
  if (isAbsolutePath(value)) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  const share = from.startsWith('\\\\')
  const parts = splitPath(dirName(from))
  // A drive or a network share is as high as a link can step.
  const top = share ? 2 : /^[A-Za-z]:/.test(from) ? 1 : 0
  for (const name of splitPath(value)) {
    if (name === '.') continue
    if (name !== '..') parts.push(name)
    else if (parts.length > top) parts.pop()
    else return null
  }
  const windows = isWindowsPath(from)
  const joined = parts.join(windows ? '\\' : '/')
  return share ? `\\\\${joined}` : windows || !isAbsolutePath(from) ? joined : `/${joined}`
}
