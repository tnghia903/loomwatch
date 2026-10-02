// ADR 0035: knowledge the operator chooses — a folder linked where it is, or a file added to the
// team. The daemon serves the folder picker and stores added files beside the team file.

import { daemonFetch } from '../daemonFetch'

export interface FolderEntry {
  name: string
  path: string
}

/** One folder as the picker shows it. Mirrors `chosen_knowledge::FolderListing`. */
export interface FolderListing {
  path: string
  name: string
  parent: string | null
  folders: FolderEntry[]
  /** File names, so the folder is recognisable. Not selectable. */
  files: string[]
  moreFiles: number
  /** Home, Desktop, Documents, Downloads — those that exist. */
  places: FolderEntry[]
}

/** A file added to a team. Mirrors `chosen_knowledge::StoredFile`. */
export interface StoredFile {
  name: string
  /** Relative to the team file's folder: what the team file's capability `path` holds. */
  path: string
  bytes: number
  /** Characters of text an agent is handed from it. */
  chars: number
  /** The prompt carries its opening; the full text is put in the agent's working folder. */
  excerpted: boolean
  note?: string
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { error?: string } | null
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && body.error ? body.error : response.statusText
    throw new Error(message)
  }
  return body as T
}

/** List a folder, or the home folder when `path` is absent. */
export async function listFolder(path?: string): Promise<FolderListing> {
  const query = path ? `?${new URLSearchParams({ path })}` : ''
  return readJson<FolderListing>(await daemonFetch(`/api/folders${query}`))
}

/** Copy a file into `<team>.files/` beside the team file. */
export async function addTeamFile(teamPath: string, file: File): Promise<StoredFile> {
  const query = new URLSearchParams({ path: teamPath, name: file.name })
  return readJson<StoredFile>(await daemonFetch(`/api/team/files?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  }))
}
