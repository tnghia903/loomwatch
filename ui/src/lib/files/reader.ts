import { createContext, useContext } from 'react'

import { extensionOf } from './fileRefs'

/**
 * Reading a file an agent made inside LoomWatch (ADR 0077), beside the chat it came from, so a part
 * of it can be marked and asked about. The daemon answers its text (`GET /api/files/read`) or, for a
 * picture or a recording, its bytes (`GET /api/files/raw`), inside the same folders the file card
 * may open.
 */
export interface FileText {
  path: string
  name: string
  kind: string
  /** The file's text, or the words read out of a PDF, Word, Excel or PowerPoint file. */
  text: string
  /** The words were read out of a document: its text without its layout. */
  extracted: boolean
  /** Only its start fitted. */
  truncated: boolean
  sizeBytes: number
  modifiedAt: string | null
  /** The version of the file read, which a change to it names (ADR 0107). An older daemon has none. */
  version?: string | null
  /** It can be changed here, and all of it was read (ADR 0107). */
  editable?: boolean
}

/** How the reader shows a file: what it is drawn as, not what made it. */
export type ReaderFormat = 'markdown' | 'page' | 'table' | 'sheet' | 'code' | 'text' | 'pdf' | 'slides' | 'document' | 'picture' | 'media'

const FORMATS: Array<[RegExp, ReaderFormat]> = [
  [/^(md|markdown|mdx)$/, 'markdown'],
  [/^html?$/, 'page'],
  [/^(csv|tsv)$/, 'table'],
  // A workbook is drawn as its sheets, from the words the daemon reads out of it (ADR 0091).
  [/^(xlsx|xlsm|xlsb|xls|ods)$/, 'sheet'],
  [/^(json|ya?ml|toml|xml|py|js|ts|tsx|jsx|rs|go|java|rb|sh|css|sql)$/, 'code'],
  [/^(txt|log)$/, 'text'],
  // A PDF is drawn as its pages, its words over them (ADR 0091); its words alone if it can't be.
  [/^pdf$/, 'pdf'],
  // A slide deck is drawn by LoomWatch itself as its slides (ADR 0091, lib/files/drawnPage.ts); its
  // words alone where it can't be. An old .ppt or a LibreOffice deck is drawn by neither, and has no
  // words LoomWatch reads: it opens in its own app.
  [/^(pptx|pptm)$/, 'slides'],
  // A Word document is drawn as its pages in the same way. An old .doc, an .odt or an .rtf is not:
  // it opens in its own app.
  [/^(docx|docm)$/, 'document'],
  [/^(png|jpe?g|gif|webp|svg|bmp)$/, 'picture'],
  [/^(mp3|wav|m4a|mp4|mov|webm)$/, 'media'],
]

/** How a file is read here, by its extension; `null` when it opens only in its own app. */
export function readerFormat(path: string): ReaderFormat | null {
  const extension = extensionOf(path)
  return FORMATS.find(([pattern]) => pattern.test(extension))?.[1] ?? null
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `${response.status} ${response.statusText}`
}

/** The file's text. Rejects with the daemon's own sentence: outside the folders, gone, not text. */
export async function readFile(path: string, signal?: AbortSignal): Promise<FileText> {
  const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await errorMessage(response))
  return (await response.json()) as FileText
}

/** Where a picture, a recording, or a deck or Word document to draw, is answered as it is. */
export function rawFileUrl(path: string): string {
  return `/api/files/raw?path=${encodeURIComponent(path)}`
}

/** The version a raw answer names in its `ETag`, for a file that can be changed here (ADR 0107). */
export function rawVersion(response: Response): string | null {
  const tag = response.headers.get('ETag')?.trim().replace(/^W\//, '')
  return tag ? tag.replace(/^"|"$/g, '') || null : null
}

/** A file written here: its version now, and the copy kept of it before, which puts it back. */
export interface Written {
  version: string
  kept: string
}

/** The file changed on disk since it was read, so the change was not written (ADR 0107). */
export class ChangedSince extends Error {}

/** A refusal in the daemon's own sentence, for the person: what went wrong and what to do now. */
export class ToldWhy extends Error {}

/** Why the daemon refused: its sentence when it said one (`ToldWhy`), else the bare status. */
export async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ? new ToldWhy(body.error) : new Error(`${response.status} ${response.statusText}`)
}

async function written(response: Response): Promise<Written> {
  if (response.status === 409) throw new ChangedSince(await errorMessage(response))
  if (!response.ok) throw await refusal(response)
  return (await response.json()) as Written
}

/**
 * Write a change made here into the file (ADR 0107), if it is still the `version` the change was
 * made on; the daemon keeps the file as it was first. Rejects with `ChangedSince` when it changed
 * on disk meanwhile.
 */
export async function writeFile(path: string, body: string | Uint8Array, version: string): Promise<Written> {
  return written(await fetch(`/api/files/write?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'If-Match': `"${version}"`, 'X-LoomWatch-Request': '1' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
  }))
}

/** Put the copy kept before a change back over its file; the file it replaces is kept the same way. */
export async function putBack(kept: string): Promise<Written> {
  return written(await fetch('/api/files/put-back', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify({ id: kept }),
  }))
}

/** A file to read, and who to ask about it: the agent whose work named it, in that piece of work. */
export interface FileToRead {
  path: string
  /** The piece of work whose answer named it. */
  runId: string | null
  /** The agent to ask: the one that made it, or the one whose answer named it. */
  from: string | null
}

/** Opens a file in the reader beside the chat, where a screen has one. */
export const FileReaderContext = createContext<((file: FileToRead) => void) | null>(null)

/** The piece of work and the agent whose answer is on screen, for the files it names. */
export const FileOriginContext = createContext<{ runId: string; from: string } | null>(null)

/**
 * Reading `path` here, when the screen has a reader and the file is a kind it reads; `null` sends
 * the card back to opening the file in its own app. `maker`: the agent whose workspace holds it,
 * who is asked before the agent whose answer only named it.
 */
export function useReadHere(path: string, maker?: string | null): (() => void) | null {
  const open = useContext(FileReaderContext)
  const origin = useContext(FileOriginContext)
  if (!open || readerFormat(path) === null) return null
  return () => open({ path, runId: origin?.runId ?? null, from: maker ?? origin?.from ?? null })
}
