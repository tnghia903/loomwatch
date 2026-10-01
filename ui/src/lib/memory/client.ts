// The Memory REST surface (crates/loomwatch-backend/src/api.rs, runs.rs).
//
// Memory never rides the WebSocket. Updates arrive as invalidation hints on the existing event
// stream and the panel reads back over REST, so docs/WEBSOCKET_SCHEMA.md stays frozen — see
// docs/TEAM_MEMORY.md "One event stream".
import { daemonFetch } from '../daemonFetch'

/** Mirrors `backend::api::MemoryEntryView`. */
export interface MemoryEntry {
  /** Relative to the team file, exactly as the team file spells it. */
  path: string
  title: string
  body: string
  chars: number
  sha256: string
  /** Agent ids this entry is supplied to; absent means the whole team. */
  appliesTo?: string[]
  /** The team this entry belongs to, when this team only inherited it. */
  origin?: string
}

/** Mirrors `backend::api::MemoryView`. */
export interface MemoryView {
  enabled: boolean
  entries: MemoryEntry[]
  budgetChars: number
  /** Characters every agent is supplied — a scoped entry is excluded, because it is not. */
  usedChars: number
  deliverAs: 'native-file' | 'packet-only'
  /** Brief entries read from the teams this team inherits. Read-only here, by construction. */
  inherited?: MemoryEntry[]
  inheritedTeams?: string[]
  /** Whether agents on this team get the four memory tools. */
  notebookEnabled?: boolean
}

/** Mirrors `backend::memory::NoteKind`. This order is the order the panel groups them. */
export const NOTE_KINDS = ['decision', 'finding', 'question', 'blocker', 'progress'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]
export type NoteState = 'active' | 'kept' | 'retired'

/**
 * Mirrors `backend::memory::Note`: one revision of one note.
 *
 * `revision` is not decoration. Keep, Correct and Retire each insert a new revision, so acting on
 * a row this panel has been showing while it was corrected elsewhere is a conflict the daemon
 * refuses — and the number is what it refuses against.
 */
export interface Note {
  id: string
  noteKey: string
  teamId: string
  /** The run it was written in, or null once kept: a kept note is the team's, not one run's. */
  runId: string | null
  authorAgentId: string
  /** The team that wrote it, when this team only inherited or imported it. */
  originTeamId?: string
  kind: NoteKind
  title: string
  body: string
  sources: string[]
  state: NoteState
  revision: number
  supersedes?: string
  /** The agent id for a write, `operator` for a Keep, Correct or Retire from the panel. */
  revisedBy: string
  createdAt: string
}

/** Mirrors `backend::notebook_api::NotebookView`. */
export interface NotebookView {
  teamId: string
  enabled: boolean
  keep: 'review' | 'never'
  notes: Note[]
  /** Kept notes of the teams this team inherits. Never writable from here. */
  inherited: Note[]
  inheritedTeams: string[]
}

/** The actor a panel action is attributed to, matching `backend::memory::OPERATOR_ACTOR`. */
export const OPERATOR_ACTOR = 'operator'

/** Mirrors `backend::memory::PacketSection`. */
export type PacketSectionKind = 'preamble' | 'brief' | 'excluded' | 'notebook' | 'checkpoint' | 'direction'
export interface PacketSection {
  kind: PacketSectionKind
  label: string
  /** Why this section is in the packet, or why it was left out. Shown verbatim. */
  rationale: string
  chars: number
  source?: { path: string; sha256: string }
  /**
   * The note revisions a `notebook` section supplied.
   *
   * Recorded by the daemon before the prompt was sent, so this still names what the agent was
   * given after the note has been corrected. Absent on every packet stored before the Notebook
   * existed, which is why it is optional rather than an empty array.
   */
  notes?: IncludedNote[]
}

/** Mirrors `backend::memory::IncludedNote`. */
export interface IncludedNote {
  id: string
  noteKey: string
  revision: number
  kind: NoteKind
  title: string
  authorAgentId: string
  originTeamId?: string
}

/**
 * Who wrote a checkpoint (`backend::memory::CheckpointSource`).
 *
 * `agent` is a stage's own statement, written in its still-warm session at its boundary.
 * `coordinator` is what LoomWatch assembled from the archive about a stage that ended abnormally:
 * its `done` is the last reply the archive holds and its `next` is empty, because nobody said.
 * The two are labelled differently everywhere, because presenting the second as the first would
 * put words in a stage's mouth.
 */
export type CheckpointSource = 'agent' | 'coordinator'

/** Mirrors `backend::memory::Checkpoint`: where one stage's work stopped. */
export interface Checkpoint {
  id: string
  runId: string
  agentId: string
  invocation: number
  done: string
  next: string
  blockers?: string
  artifacts: { path: string; sha256?: string }[]
  seqHighWater?: number
  source: CheckpointSource
  /** The team revision it was written against. Absent means "not recorded", never "matches". */
  teamRevision?: string
  ts: string
}

/** Mirrors `backend::archive::StoredContextPacket`: exactly what one agent was supplied. */
export interface ContextPacket {
  agentId: string
  invocation: number
  createdAt: string
  text: string
  sections: PacketSection[]
  budgetChars: number
  usedChars: number
}

export class MemoryApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function failure(response: Response): Promise<MemoryApiError> {
  let message = response.statusText
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') message = body.error
  } catch { /* the status text is still useful when the body is not JSON */ }
  return new MemoryApiError(message, response.status)
}

export async function fetchMemory(teamPath: string): Promise<MemoryView> {
  const response = await daemonFetch(`/api/memory?path=${encodeURIComponent(teamPath)}`)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as MemoryView
}

/**
 * Write one Brief Markdown file beside the team YAML.
 *
 * This writes only the file. Registering it in `memory.brief` is a team-file edit and goes
 * through `useTeamDocument`, so the operator saves it explicitly and sees it in the YAML
 * preview — there is deliberately no second YAML writer in the daemon.
 */
export async function writeMemoryFile(teamPath: string, file: string, body: string): Promise<MemoryEntry> {
  const response = await daemonFetch('/api/memory/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: teamPath, file, body }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as MemoryEntry
}

/**
 * One team's Notebook: its own notes and what it inherits.
 *
 * A sibling endpoint to `GET /api/memory` rather than part of it: the Brief is Markdown on disk
 * and the Notebook is Postgres rows, and one endpoint would be half-broken whenever the archive
 * is disabled. The panel reads both and shows one thing.
 */
export async function fetchNotes(teamPath: string, filter: NoteQuery = {}): Promise<NotebookView> {
  const query = new URLSearchParams({ team: teamPath })
  if (filter.run) query.set('run', filter.run)
  if (filter.kind) query.set('kind', filter.kind)
  if (filter.state) query.set('state', filter.state)
  const response = await daemonFetch(`/api/memory/notes?${query.toString()}`)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as NotebookView
}

export interface NoteQuery {
  run?: string
  kind?: NoteKind
  state?: NoteState
}

/** Every revision of one note, oldest first. What "History" opens. */
export async function fetchNoteHistory(teamPath: string, id: string): Promise<Note[]> {
  const query = new URLSearchParams({ team: teamPath })
  const response = await daemonFetch(`/api/memory/notes/${encodeURIComponent(id)}/history?${query.toString()}`)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as Note[]
}

/**
 * Keep, Correct or Retire one note.
 *
 * `revision` is sent so a panel that has gone stale is told so instead of silently overwriting
 * someone else's correction; the daemon answers 409 with the revision that is current.
 */
export async function reviseNote(
  teamPath: string,
  id: string,
  action: 'keep' | 'correct' | 'retire',
  change: { revision?: number; title?: string; body?: string } = {},
): Promise<Note> {
  const response = await daemonFetch(`/api/memory/notes/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamPath, ...change }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as Note
}

/** Export this team's Brief and kept notes as a pack folder under the teams root. */
export async function exportPack(teamPath: string, name?: string): Promise<{ pack: string; notes: number; brief: number }> {
  const response = await daemonFetch('/api/memory/packs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamPath, action: 'export', name }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as { pack: string; notes: number; brief: number }
}

/** Every stored packet for a run, or just one agent's. Empty for a run that supplied nothing. */
export async function fetchRunContext(runId: string, agentId?: string): Promise<ContextPacket[]> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : ''
  const response = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/context${query}`)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as ContextPacket[]
}

/**
 * `GET /api/runs/{id}/checkpoints?agent=` — where each of a run's stages stopped.
 *
 * An unknown run answers an empty list rather than a 404: a run from before checkpoints existed
 * left none, which is a true answer and not an error.
 */
export async function fetchRunCheckpoints(runId: string, agentId?: string): Promise<Checkpoint[]> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : ''
  const response = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/checkpoints${query}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as Checkpoint[]
}

/**
 * A file name for a note the operator types in the panel, derived from its first line.
 *
 * Deterministic and readable, because the path is what the team file will carry and what a diff
 * will show: "House constraints" becomes `brief/house-constraints.md`. A collision is the
 * caller's to resolve — `addBriefEntry` refuses a duplicate path rather than overwriting.
 *
 * `folder` should be the team's own (`<team>.brief`, as in `examples/team-memory.brief/`): teams
 * kept in one folder share its directory, and a shared `brief/` let one team's "Style guide" note
 * silently overwrite another team's file of the same name.
 */
export function briefFileNameFor(body: string, taken: readonly string[] = [], folder = 'brief'): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) ?? 'note'
  const words = firstLine
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Cut at a word boundary: the panel titles an entry with no heading from its file name, and
  // "…prefer trains over fligh" reads as a typo the operator never made.
  const slug = (words.length <= 48 ? words : words.slice(0, 49).replace(/-[^-]*$/, '').slice(0, 48)) || 'note'
  let candidate = `${folder}/${slug}.md`
  let suffix = 2
  while (taken.includes(candidate)) {
    candidate = `${folder}/${slug}-${suffix}.md`
    suffix += 1
  }
  return candidate
}
