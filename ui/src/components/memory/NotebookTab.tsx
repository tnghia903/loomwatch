import { useState } from 'react'

import { NOTE_KINDS, OPERATOR_ACTOR, type Note, type NoteKind, type NotebookView } from '../../lib/memory/client'

/**
 * The Memory panel's Notebook tab (docs/TEAM_MEMORY.md → "The Memory panel · During a run").
 *
 * Three rules from the design carry the whole shape of this file:
 *
 * * **Groups appear only when they have content.** An empty "Blockers" heading reads as a claim
 *   that blockers were looked for and none were found, which is not what an empty notebook means.
 * * **Nothing is silently overwritten.** A corrected row says who corrected it and when; a
 *   retired row stays visible and dimmed rather than disappearing. History opens every revision.
 * * **Notes are attributed, not authoritative.** Every row carries its author, its time and its
 *   source count, and the footer says so in as many words. The four words are *supplied*,
 *   *retrieved*, *kept* and *eligible* — never "the agent knows" or "remembers".
 *
 * Live updates are deliberately not a new WebSocket message: `Workspace` treats an incoming bus
 * `tool_call` named `memory_write` on the run stream as an invalidation hint and re-reads over
 * REST, which is what keeps docs/WEBSOCKET_SCHEMA.md frozen.
 */
export interface NotebookTabProps {
  view: NotebookView | null
  loading: boolean
  error: string | null
  /** False while the team cannot be edited here; Keep, Correct and Retire are then unavailable. */
  editable: boolean
  onRevise: (id: string, action: 'keep' | 'correct' | 'retire', change: { revision: number; title?: string; body?: string }) => Promise<void>
  onHistory: (id: string) => Promise<Note[]>
  onRetry: () => void
}

/** The heading each kind is grouped under, in the design's order. */
const GROUP_LABELS: Record<NoteKind, string> = {
  decision: 'Decisions',
  finding: 'Findings',
  question: 'Open questions',
  blocker: 'Blockers',
  progress: 'Progress',
}

export function NotebookTab({ view, loading, error, editable, onRevise, onHistory, onRetry }: NotebookTabProps) {
  if (loading) return <p className="hint t-meta" style={{ margin: 0 }}>Reading the notebook…</p>
  if (error) {
    return (
      <div className="inline-error" role="alert">
        <span className="msg t-body">Couldn't read this team's notebook.</span>
        <span className="detail t-mono-sm">{error}</span>
        <span><button type="button" className="btn" onClick={onRetry}>Try again</button></span>
      </div>
    )
  }
  if (!view) return null
  if (!view.enabled) {
    return (
      <p className="t-body" style={{ margin: 0 }}>
        This team's notebook is off, so its agents are given no memory tools and write no notes.
      </p>
    )
  }
  const own = view.notes
  const inherited = view.inherited
  if (own.length === 0 && inherited.length === 0) {
    return (
      <p className="t-body" style={{ margin: 0 }}>
        Nothing recorded yet. Agents write here while they work; you decide what outlives the run.
      </p>
    )
  }

  return (
    <>
      {NOTE_KINDS.map((kind) => {
        const group = own.filter((note) => note.kind === kind)
        // Groups appear only when they have content.
        if (group.length === 0) return null
        return (
          <div className="zone" key={kind}>
            <div className="zone-head t-micro"><span>{GROUP_LABELS[kind]}</span><span>{group.length}</span></div>
            {group.map((note) => (
              <NoteRow key={note.id} note={note} canKeep={view.keep !== 'never'} editable={editable} onRevise={onRevise} onHistory={onHistory} />
            ))}
          </div>
        )
      })}

      {inherited.length > 0 && (
        <div className="zone">
          <div className="zone-head t-micro">
            <span>Inherited · read-only</span><span>{inherited.length}</span>
          </div>
          {inherited.map((note) => (
            <NoteRow key={note.id} note={note} editable={false} onRevise={onRevise} onHistory={onHistory} inherited />
          ))}
        </div>
      )}

      <p className="hint t-meta" style={{ margin: 0 }}>
        Notes are the team's observations, attributed and dated. They are not verified facts, and a
        note being supplied does not mean an agent followed it.
      </p>
    </>
  )
}

function NoteRow({
  note, editable, onRevise, onHistory, inherited = false, canKeep = true,
}: {
  note: Note
  editable: boolean
  onRevise: NotebookTabProps['onRevise']
  onHistory: NotebookTabProps['onHistory']
  inherited?: boolean
  canKeep?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<Note[] | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const retired = note.state === 'retired'

  async function act(action: 'keep' | 'correct' | 'retire', change?: { title: string; body: string }) {
    setBusy(true)
    setFailed(null)
    try {
      await onRevise(note.id, action, { revision: note.revision, ...change })
      setDraft(null)
    } catch (caught: unknown) {
      setFailed(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="rt-strip t-meta"
      data-note-state={note.state}
      style={{
        borderTop: 0, padding: '8px 10px', borderRadius: 'var(--r-sm)',
        background: 'var(--color-panel-solid)',
        border: inherited ? '1px dashed var(--color-hairline)' : '1px solid var(--color-hairline)',
        alignItems: 'flex-start', flexDirection: 'column', gap: 4,
        // Retired stays visible and dimmed: hiding it would lose the record of what the team
        // once believed, which is the point of keeping history at all.
        opacity: retired ? 0.55 : 1,
      }}
    >
      <span style={{ display: 'flex', width: '100%', gap: 'var(--sp-3)', alignItems: 'baseline' }}>
        <span className="t-micro" style={{ color: 'var(--color-ink-3)', textTransform: 'uppercase' }}>{note.kind}</span>
        <b className="t-body-m" style={{ color: 'var(--color-ink)', flex: 1, minWidth: 0 }}>{note.title}</b>
        {note.state === 'kept' && <span className="t-micro" style={{ color: 'var(--color-ink-2)' }}>Kept</span>}
      </span>
      <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{metaLine(note)}</span>
      <span className="t-meta" style={{ color: 'var(--color-ink-2)' }}>{preview(note.body)}</span>

      <span style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        {canKeep && !inherited && note.state === 'active' && (
          <button type="button" className="link t-meta" disabled={!editable || busy} onClick={() => void act('keep')}
            title="Let the next run find this note. It stops belonging to this run.">Keep</button>
        )}
        {!inherited && !retired && (
          <button type="button" className="link t-meta" disabled={!editable || busy}
            onClick={() => { setFailed(null); setDraft({ title: note.title, body: note.body }) }}
            title="Write a new revision. The old one is kept.">Correct</button>
        )}
        {!inherited && !retired && (
          <button type="button" className="link t-meta" disabled={!editable || busy} onClick={() => void act('retire')}
            title="Stop supplying and searching this note. It stays readable here.">Retire</button>
        )}
        <button type="button" className="link t-meta" aria-expanded={open}
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next && !history) void onHistory(note.id).then(setHistory).catch(() => setHistory([]))
          }}>History</button>
      </span>

      {failed && <span className="t-meta" role="alert" style={{ color: 'var(--color-alert)' }}>{failed}</span>}

      {draft && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
          <input className="input" aria-label={`Correct the title of ${note.title}`} value={draft.title} disabled={busy}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <textarea className="input" aria-label={`Correct the body of ${note.title}`} value={draft.body} disabled={busy}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
          <span style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !draft.title.trim()}
              onClick={() => void act('correct', draft)}>{busy ? 'Saving…' : 'Save the correction'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(null); setFailed(null) }}>Cancel</button>
          </span>
          <span className="t-meta" style={{ color: 'var(--color-ink-3)' }}>
            This writes revision {note.revision + 1}. Revision {note.revision} is kept, and every packet that
            supplied it still names it.
          </span>
        </span>
      )}

      {open && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
          {history === null && <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>Reading the history…</span>}
          {history?.map((revision) => (
            <span key={revision.id} className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>
              revision {revision.revision} · {revision.state} · {revision.revisedBy} · {time(revision.createdAt)} · {revision.title}
            </span>
          ))}
          {history?.length === 0 && <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>No history was returned.</span>}
        </span>
      )}
    </div>
  )
}

/**
 * Author, time, sources — and, for a revision the operator made, who corrected it and when.
 *
 * The design's row reads "Reviewer · 14:41 · corrected by you 14:43". "You" is right here and
 * not a guess: only the operator's own actions are attributed to `operator`, because the daemon
 * derives an agent's identity from its bus token and never from what it claims.
 */
function metaLine(note: Note): string {
  const parts = [note.originTeamId ?? note.authorAgentId, time(note.createdAt)]
  if (note.originTeamId) parts.push(`wrote this · via ${note.authorAgentId}`)
  if (note.sources.length > 0) parts.push(`${note.sources.length} source${note.sources.length === 1 ? '' : 's'}`)
  if (note.revision > 1) {
    parts.push(
      note.revisedBy === OPERATOR_ACTOR
        ? `corrected by you ${time(note.createdAt)}`
        : `revised by ${note.revisedBy} ${time(note.createdAt)}`,
    )
  }
  if (note.state === 'retired') parts.push('retired · superseded')
  return parts.join(' · ')
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

function time(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
